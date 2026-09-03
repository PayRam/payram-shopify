/**
 * Settlement — deciding what an arriving Payram payment means for a Shopify order.
 *
 * WHY THIS EXISTS
 * ---------------
 * Crypto payments are not all-or-nothing. A buyer can send slightly less (network
 * fees, rounding, a price tick between quote and send) or slightly more. Payram
 * already reports this: `SendWebhookToMerchant` in payram-core classifies every
 * payment as OPEN / FILLED / PARTIALLY_FILLED / OVER_FILLED / CANCELLED.
 *
 * The connector previously collapsed that to a single "is it paid" check against
 * the strings ["paid","confirmed","closed","completed"] — none of which Payram
 * ever sends. This module replaces that with a three-way settlement.
 *
 * TOP-UPS
 * -------
 * When a buyer sends more crypto after an underpayment, payram-core does not add
 * to the original payment request — `handlePaymentRequest` matches only on
 * `status = 'open'` and assigns rather than accumulates, so a second deposit
 * creates a NEW payment request with a NEW referenceID. That top-up still
 * carries the same `customer_id` (the member is unchanged), which is how we trace
 * it back to the order.
 *
 * So the connector sums across every reference it has seen for the order, not
 * whatever the latest webhook happens to say. Rows are keyed by reference, so
 * webhook retries are idempotent.
 *
 * TRUST
 * -----
 * The Payram webhook is unsigned (MF-004), so its amounts are attacker-supplied.
 * Anything that moves money -- issuing a gift card -- requires `verified: true`,
 * meaning the figures were re-read from Payram directly. Unverified payments are
 * still recorded and tagged; they simply never mint value.
 *
 * Rules: R-DB-TX (reads and writes that inform each other are transactional),
 * R-API-FOR-AGENTS (merchant-facing text says what to do next),
 * R-MALICIOUS-FLOW (MF-008).
 */
import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { convertFromUsd, convertFromUsdAtRate } from "~/utils/fx.server";
import { sumReceivedUsd } from "~/utils/payment-session.server";
import {
  addOrderTags,
  appendOrderNote,
  createGiftCard,
  fetchOrderSettlementContext,
} from "~/utils/shopify-admin.server";

/** Payram's payment classification, as sent on the merchant webhook. */
export type PayramState =
  | "OPEN"
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "OVER_FILLED"
  | "CANCELLED"
  | "UNDEFINED";

/** Fallbacks when a shop has no config row yet. */
const DEFAULT_TOLERANCE_PERCENT = "1.0";
const DEFAULT_TOLERANCE_MIN_USD = "1.00";

/**
 * How close to the invoice counts as paid.
 *
 * A flat tolerance is wrong for crypto. The gap between quote and settlement is
 * proportional — network fees and price drift scale with the transfer — so a
 * $1,000 order can legitimately arrive several dollars short while a $10 order
 * cannot. The tolerance therefore scales with the invoice, with a floor so small
 * orders still get a workable allowance.
 *
 *     tolerance = max(invoiced × percent%, floor)
 *
 * Both halves are merchant-configurable; the merchant is the one carrying the
 * risk, so the merchant sets the appetite.
 */
export function effectiveTolerance(
  invoicedUsd: Prisma.Decimal,
  percent: string | null | undefined,
  minUsd: string | null | undefined,
): Prisma.Decimal {
  const pct = safeDecimal(percent, DEFAULT_TOLERANCE_PERCENT);
  const floor = safeDecimal(minUsd, DEFAULT_TOLERANCE_MIN_USD);
  const proportional = invoicedUsd.times(pct).dividedBy(100);
  return proportional.greaterThan(floor) ? proportional : floor;
}

/** Parse a stored decimal string, falling back when absent or malformed. */
function safeDecimal(value: string | null | undefined, fallback: string): Prisma.Decimal {
  try {
    const d = new Prisma.Decimal(value ?? fallback);
    return d.isFinite() && !d.isNegative() ? d : new Prisma.Decimal(fallback);
  } catch {
    return new Prisma.Decimal(fallback);
  }
}

export const TAG_PAID = "payram_paid";
export const TAG_PARTIAL = "payram_partially_paid";
export const TAG_OVERPAID = "payram_overpaid";

/**
 * Map an incoming status to Payram's vocabulary.
 *
 * Payram sends the uppercase states. The legacy aliases are kept because earlier
 * connector builds expected them and a merchant may still be running an older
 * payram-core; treating an unknown value as UNDEFINED (rather than as "paid") is
 * the safe direction to fail.
 */
export function normalizePayramState(raw: unknown): PayramState {
  const v = String(raw ?? "").trim().toUpperCase();
  switch (v) {
    case "OPEN":
    case "FILLED":
    case "PARTIALLY_FILLED":
    case "OVER_FILLED":
    case "CANCELLED":
      return v;
    // Legacy / defensive aliases for a fully-settled payment.
    case "PAID":
    case "CONFIRMED":
    case "CLOSED":
    case "COMPLETED":
      return "FILLED";
    default:
      return "UNDEFINED";
  }
}

/** Outcome of settling an order, for logging and the webhook response. */
export interface SettlementOutcome {
  state: PayramState;
  /** Cumulative USD received across every reference for this order. */
  receivedUsd: string;
  /** USD invoiced, as recorded when the payment was created. */
  invoicedUsd: string | null;
  /** received − invoiced. Negative = still owed. */
  balanceUsd: string | null;
  settled: boolean;
  giftCardIssued: boolean;
  note: string | null;
  /** Non-fatal problems (e.g. gift card refused) — stored, never thrown. */
  warnings: string[];
}

/** Format money for a merchant-facing note. */
function money(amount: Prisma.Decimal, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/**
 * Record a payment against an order and bring the Shopify order into line.
 *
 * Never throws for Shopify-side failures: a webhook that 500s would be retried
 * by Payram forever for a permanent condition. Problems are captured in
 * `warnings` and persisted to `syncError`.
 */
export async function settleOrder(params: {
  shop: string;
  shopifyOrderId: string;
  referenceId: string;
  state: PayramState;
  filledAmountInUsd: string | null;
  txHash: string | null;
  accessToken: string;
  /** True only when the amounts were re-read from Payram, not taken from the webhook. */
  verified: boolean;
}): Promise<SettlementOutcome> {
  const {
    shop,
    shopifyOrderId,
    referenceId,
    state,
    filledAmountInUsd,
    txHash,
    accessToken,
    verified,
  } = params;

  const warnings: string[] = [];

  // Defence in depth. The webhook already refuses UNDEFINED, but this function
  // is the thing that tags orders paid and mints gift cards, so it must not be
  // possible to reach that from a state nobody recognised.
  if (state === "UNDEFINED") {
    return {
      state,
      receivedUsd: "0.00",
      invoicedUsd: null,
      balanceUsd: null,
      settled: false,
      giftCardIssued: false,
      note: null,
      warnings: [
        "Refusing to settle an order from an unrecognised payment status.",
      ],
    };
  }

  // --- Record this reference, then recompute the total from all of them ---
  // R-DB-TX: the upsert and the aggregate read are one atomic unit, so a
  // concurrent webhook cannot make the sum disagree with the rows.
  const { received, mapping, unchanged } = await prisma.$transaction(async (tx) => {
    // Payram re-sends a webhook every 3 seconds for the whole confirmation
    // window (webhook_processor_job.go ticks at 3s and re-sends for every
    // confirming deposit). A 12-confirmation BTC payment therefore arrives
    // thousands of times. Detect "nothing actually changed" BEFORE overwriting
    // the row, so repeat deliveries cost one query instead of four network calls.
    const prior = await tx.payramPayment.findUnique({
      where: { payramReferenceId: referenceId },
    });
    const same =
      prior !== null &&
      prior.state === state &&
      prior.filledAmountInUsd === filledAmountInUsd;

    await tx.payramPayment.upsert({
      where: { payramReferenceId: referenceId },
      create: {
        shop,
        shopifyOrderId,
        payramReferenceId: referenceId,
        state,
        filledAmountInUsd,
        txHash,
      },
      update: { state, filledAmountInUsd, txHash, updatedAt: new Date() },
    });

    // One implementation of the money-summing rule, shared with the payment page
    // — the two must never be able to disagree about what an order has received.
    const total = await sumReceivedUsd(tx, shop, shopifyOrderId);

    const m = await tx.paymentMapping.findUnique({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
    });

    return { received: total, mapping: m, unchanged: same };
  });

  // The caller resolved the mapping before calling us, so its absence here means
  // the row was deleted mid-flight. Nothing to settle against.
  if (!mapping) {
    return {
      state,
      receivedUsd: received.toFixed(2),
      invoicedUsd: null,
      balanceUsd: null,
      settled: false,
      giftCardIssued: false,
      note: null,
      warnings: [`No order mapping found for ${shop} order ${shopifyOrderId}.`],
    };
  }

  const invoiced = mapping.amountInUsd
    ? new Prisma.Decimal(mapping.amountInUsd)
    : null;

  // Without a recorded invoice amount there is nothing to settle against. This
  // happens for orders created before the currency fix shipped.
  if (!invoiced) {
    warnings.push(
      "No invoiced USD amount recorded for this order, so the payment could not be " +
        "reconciled automatically. Check the order against Payram manually.",
    );
    await persist(shop, shopifyOrderId, {
      paymentState: state,
      filledAmountInUsd: received.toFixed(2),
      syncError: warnings.join(" "),
      lastSyncAt: new Date(),
    });
    return {
      state,
      receivedUsd: received.toFixed(2),
      invoicedUsd: null,
      balanceUsd: null,
      settled: false,
      giftCardIssued: false,
      note: null,
      warnings,
    };
  }

  // Repeat delivery of a payment we have already acted on: the order is already
  // in the right state, so touching Shopify again would burn rate limit for no
  // change. A stored syncError means the last attempt did not finish, so those
  // are always retried.
  if (unchanged && mapping.paymentState === state && !mapping.syncError) {
    const priorBalance = mapping.balanceUsd ?? null;
    return {
      state,
      receivedUsd: received.toFixed(2),
      invoicedUsd: invoiced.toFixed(2),
      balanceUsd: priorBalance,
      settled: priorBalance !== null && !new Prisma.Decimal(priorBalance).lessThan(0),
      giftCardIssued: Boolean(mapping.giftCardId),
      note: null,
      warnings: [],
    };
  }

  const config = await prisma.merchantConfig.findUnique({ where: { shop } });

  const balance = received.minus(invoiced);
  const tolerance = effectiveTolerance(
    invoiced,
    config?.settlementTolerancePercent,
    config?.settlementToleranceMinUsd,
  );
  const isShort = balance.lessThan(tolerance.negated());
  const isOver = balance.greaterThan(tolerance);
  const settled = !isShort;

  // --- Express the difference in the currency the merchant thinks in ---
  const orderCurrency = mapping.orderCurrency ?? "USD";
  let differenceLocal: Prisma.Decimal | null = null;
  try {
    differenceLocal = mapping.fxRate
      ? convertFromUsdAtRate(balance.abs(), mapping.fxRate)
      : await convertFromUsd(balance.abs(), orderCurrency);
  } catch (err) {
    // Only affects wording of the note; USD figures are still exact.
    console.warn("[payram-settle] could not express difference in order currency:", err);
  }

  // --- Decide tags and note ---
  const tags: string[] = [];
  let note: string;

  if (isShort) {
    tags.push(TAG_PARTIAL);
    const localPart =
      differenceLocal && orderCurrency !== "USD"
        ? ` (${money(differenceLocal, orderCurrency)})`
        : "";
    note =
      `Payram: underpaid. Received ${money(received, "USD")} of ` +
      `${money(invoiced, "USD")}. Still due ${money(balance.abs(), "USD")}${localPart}. ` +
      `Do not fulfil until the balance is settled.`;
  } else if (isOver) {
    tags.push(TAG_PAID, TAG_OVERPAID);
    const localPart =
      differenceLocal && orderCurrency !== "USD"
        ? ` (${money(differenceLocal, orderCurrency)})`
        : "";
    note =
      `Payram: paid in full, overpaid by ${money(balance, "USD")}${localPart}. ` +
      `Received ${money(received, "USD")} of ${money(invoiced, "USD")}.`;
  } else {
    tags.push(TAG_PAID);
    note = `Payram: paid in full — ${money(received, "USD")}.`;
  }

  // --- Apply to Shopify ---
  let orderContext: Awaited<ReturnType<typeof fetchOrderSettlementContext>> | null =
    null;
  try {
    orderContext = await fetchOrderSettlementContext(shop, accessToken, shopifyOrderId);
  } catch (err) {
    warnings.push(
      `Could not read the Shopify order: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await addOrderTags(shop, accessToken, shopifyOrderId, tags);
  } catch (err) {
    warnings.push(
      `Could not tag the order: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await appendOrderNote(
      shop,
      accessToken,
      shopifyOrderId,
      orderContext?.note ?? null,
      note,
    );
  } catch (err) {
    warnings.push(
      `Could not add the order note: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // --- Overpayment: return the excess as a gift card ---
  let giftCardIssued = false;
  const giftFields: Record<string, string | null> = {};

  if (isOver) {
    const minimum = safeDecimal(config?.giftCardMinimumUsd, "1.00");

    if (!verified) {
      // Refuse to mint value from figures we could not confirm with Payram.
      warnings.push(
        `Overpaid by ${money(balance, "USD")}, but the payment could not be verified ` +
          "with Payram, so no gift card was issued. Confirm the payment in Payram and " +
          "refund manually.",
      );
    } else if (!config?.autoGiftCardOnOverpayment) {
      warnings.push(
        `Overpaid by ${money(balance, "USD")}. Automatic gift cards are off, so this ` +
          "must be refunded manually. Enable it in the Payram app settings to automate it.",
      );
    } else if (balance.lessThan(minimum)) {
      warnings.push(
        `Overpaid by ${money(balance, "USD")}, which is below the ${money(minimum, "USD")} ` +
          "gift card minimum. No gift card was issued.",
      );
    } else if (mapping.giftCardId) {
      // A card already exists for this order. Never issue a second one
      // automatically — a retried webhook must not mint value twice.
      giftCardIssued = true;
      // But if genuinely more money has since arrived, say so rather than
      // silently pocketing it. Under-issuing is safe; staying quiet is not.
      const alreadyRefunded = new Prisma.Decimal(mapping.balanceUsd ?? 0);
      const newExcess = balance.minus(alreadyRefunded);
      if (newExcess.greaterThanOrEqualTo(minimum)) {
        warnings.push(
          `A further ${money(newExcess, "USD")} arrived after the ${money(
            alreadyRefunded,
            "USD",
          )} overpayment was already refunded as a gift card. Refund the ` +
            "difference manually — no second card is issued automatically.",
        );
      }
    } else {
      try {
        // Gift cards are denominated in the shop's own currency, which under
        // Shopify Markets is not necessarily the buyer's presentment currency.
        const giftCurrency = orderContext?.shopCurrencyCode ?? orderCurrency;
        const giftAmount =
          giftCurrency === orderCurrency && mapping.fxRate
            ? convertFromUsdAtRate(balance, mapping.fxRate)
            : await convertFromUsd(balance, giftCurrency);

        const card = await createGiftCard(shop, accessToken, {
          amount: giftAmount.toFixed(2),
          customerId: orderContext?.customerId ?? null,
          note: `Payram overpayment refund for order ${
            orderContext?.orderName ?? shopifyOrderId
          } (${money(balance, "USD")} overpaid).`,
          message:
            "You sent a little more than your order total. Here is the difference as a gift card.",
        });

        giftCardIssued = true;
        giftFields.giftCardId = card.id;
        giftFields.giftCardLastChars = card.lastCharacters;
        giftFields.giftCardAmount = giftAmount.toFixed(2);
        giftFields.giftCardCurrency = card.currencyCode ?? giftCurrency;

        const delivery = card.notified
          ? "Shopify has emailed it to the customer."
          : "No customer was attached, so send the code from Shopify Admin → Gift cards.";
        try {
          await appendOrderNote(
            shop,
            accessToken,
            shopifyOrderId,
            // Pass the note as Shopify last reported it and let appendOrderNote
            // append. Synthesising `existing + settlement line` here duplicated
            // that line on any retry, because the fetched note already had it.
            orderContext?.note ?? null,
            `Payram: refunded overpayment as gift card ${money(
              giftAmount,
              giftFields.giftCardCurrency ?? "",
            )} ending ${card.lastCharacters ?? "?"}. ${delivery}`,
          );
        } catch (err) {
          warnings.push(
            `Gift card was created but the order note failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } catch (err) {
        warnings.push(
          `Overpaid by ${money(balance, "USD")} but the gift card could not be created: ${
            err instanceof Error ? err.message : String(err)
          }. Refund manually.`,
        );
      }
    }
  }

  await persist(shop, shopifyOrderId, {
    paymentState: state,
    filledAmountInUsd: received.toFixed(2),
    balanceUsd: balance.toFixed(2),
    payramStatus: state,
    shopifyFinancialStatus: settled ? TAG_PAID : TAG_PARTIAL,
    shopifyPaidSyncedAt: settled ? new Date() : null,
    lastSyncAt: new Date(),
    syncError: warnings.length ? warnings.join(" ") : null,
    ...giftFields,
  });

  return {
    state,
    receivedUsd: received.toFixed(2),
    invoicedUsd: invoiced.toFixed(2),
    balanceUsd: balance.toFixed(2),
    settled,
    giftCardIssued,
    note,
    warnings,
  };
}

/** Single-statement update — atomic on its own. */
async function persist(
  shop: string,
  shopifyOrderId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await prisma.paymentMapping.update({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
    data: data as never,
  });
}
