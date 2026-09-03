/**
 * Payment session — the two phases behind the durable payment page.
 *
 * `/pay/{token}` renders instantly from the database and then calls these:
 *
 *   quoteOrder()     what is owed, in both currencies, at a fixed rate
 *   createCheckout() a Payram checkout link for exactly that amount
 *
 * Splitting them is what removes the blank tab. The page appears immediately,
 * the quote fills in real numbers the buyer can check ("€50.00 = $54.22 at
 * 1.0845"), and only then does the slower Payram call run. The progress the
 * buyer sees is a real description of work actually happening, not a spinner.
 *
 * ONE LINK AT A TIME
 * ------------------
 * payram-core's CreateNewPaymentRequest calls
 * CancelPreviousOpenPaymentRequestsByMemberId, so issuing a new payment request
 * CANCELS the member's previous open one. If we reissued on every page view we
 * would repeatedly kill the link the buyer is trying to pay. So a live link is
 * reused while the outstanding amount is unchanged, and only replaced when the
 * amount actually moves — at which point cancelling the stale link is correct.
 *
 * Rules: R-DB-TX, R-API-FOR-AGENTS, R-REUSE-FIRST.
 */
import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import {
  convertToUsd,
  convertFromUsdAtRate,
  FxRateUnavailableError,
} from "~/utils/fx.server";
import { createPayramPayment } from "~/utils/payram.server";
import {
  fetchOrderTotal,
  findOfflineAccessToken,
} from "~/utils/shopify-admin.server";

/** Amounts are settled to cents. */
const CENTS = 2;

/** A live link older than this is re-struck so the buyer never pays a stale rate. */
const LINK_MAX_AGE_MS = 30 * 60 * 1000;

/** How long a "creating" claim blocks a second attempt before it is reclaimable. */
const CLAIM_STALE_MS = 60 * 1000;

export type PaymentPhase = "unpaid" | "partial" | "paid";

export interface PaymentQuote {
  orderName: string | null;
  /** Presentment currency of the order, e.g. "EUR". */
  currency: string;
  /** Full order total in `currency`. */
  orderTotal: string;
  /** Total invoiced in USD — struck once and held stable. */
  invoicedUsd: string;
  /** Everything received so far, across every Payram reference. */
  receivedUsd: string;
  /**
   * Received, expressed in the buyer's own currency at the invoice rate.
   * The page shows every row in one currency: mixing "$36.89 received" into a
   * EUR total makes the figures look like they do not add up, which is the last
   * thing a payment page should do.
   */
  receivedLocal: string;
  /** Still owed, in USD. Zero once settled. */
  remainingUsd: string;
  /** Still owed, in the buyer's own currency, at the invoice rate. */
  remainingLocal: string;
  fxRate: string;
  phase: PaymentPhase;
  /** A checkout link already issued for exactly this amount, if any. */
  existingCheckoutUrl: string | null;
}

export class PaymentSessionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PaymentSessionError";
    this.status = status;
  }
}

/**
 * Everything received for an order, ignoring cancelled requests.
 *
 * Exported because settlement sums the same rows: a second copy of this rule
 * could drift, and the two disagreeing about what an order has received is
 * exactly the class of bug this connector exists to remove.
 */
export async function sumReceivedUsd(
  tx: Prisma.TransactionClient | typeof prisma,
  shop: string,
  shopifyOrderId: string,
): Promise<Prisma.Decimal> {
  const rows = await tx.payramPayment.findMany({
    where: { shop, shopifyOrderId },
    select: { filledAmountInUsd: true, state: true },
  });
  return rows
    .filter((r) => r.state !== "CANCELLED")
    .reduce(
      (sum, r) => sum.plus(new Prisma.Decimal(r.filledAmountInUsd ?? 0)),
      new Prisma.Decimal(0),
    );
}

/**
 * What does this buyer owe right now?
 *
 * Reads the order total from Shopify (never from the browser), strikes the USD
 * invoice once, and reports it against everything received so far.
 */
export async function quoteOrder(
  shop: string,
  shopifyOrderId: string,
): Promise<PaymentQuote> {
  const accessToken = await findOfflineAccessToken(shop);
  if (!accessToken) {
    throw new PaymentSessionError(
      "This store's Payram app is not fully connected, so the amount could not be " +
        "confirmed. Please contact the store.",
      503,
    );
  }

  const mapping = await prisma.paymentMapping.findUnique({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
  });

  const order = await fetchOrderTotal(shop, accessToken, shopifyOrderId);

  // The invoice is struck once and held. Re-deriving it on every visit would let
  // the amount owed drift with the exchange rate while the buyer is deciding.
  // It is only re-struck if the merchant has since edited the order total.
  const orderTotalChanged =
    mapping?.orderAmount != null &&
    !new Prisma.Decimal(mapping.orderAmount).equals(new Prisma.Decimal(order.amount));

  let invoicedUsd: Prisma.Decimal;
  let fxRate: Prisma.Decimal;
  let fxSource: string;

  if (mapping?.amountInUsd && mapping.fxRate && !orderTotalChanged) {
    invoicedUsd = new Prisma.Decimal(mapping.amountInUsd);
    fxRate = new Prisma.Decimal(mapping.fxRate);
    fxSource = mapping.fxSource ?? "stored";
  } else {
    let conversion;
    try {
      conversion = await convertToUsd(order.amount, order.currencyCode);
    } catch (err) {
      if (err instanceof FxRateUnavailableError) {
        throw new PaymentSessionError(
          `We could not convert your ${err.currency} total to USD just now, so no ` +
            "payment was created. Please try again in a few minutes — your order is safe.",
          503,
        );
      }
      throw new PaymentSessionError(
        err instanceof Error ? err.message : String(err),
        500,
      );
    }
    invoicedUsd = conversion.amountInUsd;
    fxRate = conversion.usdPerUnit;
    fxSource = conversion.source;

    // Persist the struck invoice so later visits and settlement agree with it.
    await prisma.paymentMapping.upsert({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
      create: {
        shop,
        shopifyOrderId,
        shopifyOrderName: order.orderName,
        orderCurrency: conversion.currency,
        orderAmount: conversion.originalAmount.toString(),
        fxRate: fxRate.toString(),
        fxSource,
        amountInUsd: invoicedUsd.toFixed(CENTS),
        payramStatus: "quoted",
      },
      update: {
        shopifyOrderName: order.orderName,
        orderCurrency: conversion.currency,
        orderAmount: conversion.originalAmount.toString(),
        fxRate: fxRate.toString(),
        fxSource,
        amountInUsd: invoicedUsd.toFixed(CENTS),
        updatedAt: new Date(),
      },
    });
  }

  const received = await sumReceivedUsd(prisma, shop, shopifyOrderId);

  // Shopify says nothing is outstanding — a gift card covered it, or the
  // merchant marked it paid. Whatever our own ledger says, do not ask the buyer
  // to pay again.
  const rawRemaining = order.fullyPaidInShopify
    ? new Prisma.Decimal(0)
    : invoicedUsd.minus(received);
  const remaining = rawRemaining.isNegative()
    ? new Prisma.Decimal(0)
    : rawRemaining.toDecimalPlaces(CENTS, Prisma.Decimal.ROUND_HALF_UP);

  const phase: PaymentPhase = remaining.isZero()
    ? "paid"
    : received.greaterThan(0)
      ? "partial"
      : "unpaid";

  // Offer the existing link back only if it is for this exact amount and fresh.
  const linkIsCurrent =
    mapping?.payramCheckoutUrl != null &&
    mapping.linkAmountUsd != null &&
    new Prisma.Decimal(mapping.linkAmountUsd).equals(remaining) &&
    mapping.linkCreatedAt != null &&
    Date.now() - mapping.linkCreatedAt.getTime() < LINK_MAX_AGE_MS;

  return {
    orderName: order.orderName ?? mapping?.shopifyOrderName ?? null,
    currency: order.currencyCode,
    orderTotal: order.amount,
    invoicedUsd: invoicedUsd.toFixed(CENTS),
    receivedUsd: received.toFixed(CENTS),
    receivedLocal: convertFromUsdAtRate(received, fxRate).toFixed(CENTS),
    remainingUsd: remaining.toFixed(CENTS),
    remainingLocal: convertFromUsdAtRate(remaining, fxRate).toFixed(CENTS),
    fxRate: fxRate.toString(),
    phase,
    existingCheckoutUrl: linkIsCurrent ? mapping!.payramCheckoutUrl : null,
  };
}

export interface CheckoutSession {
  checkoutUrl: string;
  amountUsd: string;
  reused: boolean;
}

/**
 * Get a Payram checkout link for what is currently owed.
 *
 * Reuses the live link when the amount has not moved; otherwise issues a new one.
 */
export async function createCheckout(
  shop: string,
  shopifyOrderId: string,
  email?: string,
): Promise<CheckoutSession> {
  const quote = await quoteOrder(shop, shopifyOrderId);

  if (quote.phase === "paid") {
    throw new PaymentSessionError(
      "This order is already paid in full. Nothing further is owed.",
      409,
    );
  }

  if (quote.existingCheckoutUrl) {
    return {
      checkoutUrl: quote.existingCheckoutUrl,
      amountUsd: quote.remainingUsd,
      reused: true,
    };
  }

  const remaining = new Prisma.Decimal(quote.remainingUsd);

  // Claim the order before calling out, so a second tab (or a double-tap, or a
  // Back-navigation re-firing `auto=1`) cannot start a parallel Payram request.
  //
  // This is a compare-and-set, not a plain update: an unconditional write would
  // let both callers "claim" and both create payment requests — and
  // payram-core's CancelPreviousOpenPaymentRequestsByMemberId would then cancel
  // the first, killing the link the buyer may already be paying. A claim older
  // than the stale window is reclaimable so a crashed attempt cannot wedge the
  // order forever.
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
  const claim = await prisma.paymentMapping.updateMany({
    where: {
      shop,
      shopifyOrderId,
      OR: [{ payramStatus: { not: "creating" } }, { updatedAt: { lt: staleBefore } }],
    },
    data: { payramStatus: "creating", updatedAt: new Date() },
  });

  if (claim.count === 0) {
    throw new PaymentSessionError(
      "A payment link for this order is already being prepared. Give it a moment, " +
        "then refresh this page.",
      409,
    );
  }

  // Fall back to the email captured at the Thank You block, so a buyer returning
  // to a bookmarked link still gets a Payram receipt without retyping it.
  const stored = await prisma.paymentMapping.findUnique({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
    select: { buyerEmail: true },
  });
  const customerEmail = email ?? stored?.buyerEmail ?? undefined;

  let checkoutUrl: string;
  let referenceId: string;
  try {
    const result = await createPayramPayment({
      shop,
      shopifyOrderId,
      amountInUsd: remaining,
      customerEmail,
    });
    checkoutUrl = result.checkoutUrl;
    referenceId = result.referenceId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error ? (err.cause as Error | undefined) : undefined;
    const detail = `${msg}${cause ? ` (${cause.message ?? cause})` : ""}`;
    console.error("[payram-session] createPayramPayment failed:", detail);

    await prisma.paymentMapping
      .update({
        where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
        data: { payramStatus: "failed", syncError: detail, lastSyncAt: new Date() },
      })
      .catch(() => {});

    throw new PaymentSessionError(
      "Payram could not create this payment. Please try again in a few minutes — " +
        "your order is safe and you have not been charged.",
      502,
    );
  }

  await prisma.paymentMapping.update({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
    data: {
      payramReferenceId: referenceId,
      payramCheckoutUrl: checkoutUrl,
      payramStatus: "created",
      linkAmountUsd: remaining.toFixed(CENTS),
      linkCreatedAt: new Date(),
      syncError: null,
      updatedAt: new Date(),
    },
  });

  console.info("[payram-session] issued checkout link", {
    shopifyOrderId,
    referenceId,
    amountUsd: remaining.toFixed(CENTS),
  });

  return {
    checkoutUrl,
    amountUsd: remaining.toFixed(CENTS),
    reused: false,
  };
}
