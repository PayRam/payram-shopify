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
 * The Payram webhook body is attacker-supplied: older Payram releases do not
 * sign it (MF-004), and the `customer_id` it is matched on is printed in the
 * buyer's own payment link. So the rule is absolute:
 *
 *   Only figures Payram itself confirms — the reference exists AND its
 *   customerId is this order's — become money received, tag or note an order,
 *   mark it paid, or mint a gift card. An unconfirmed message changes no money
 *   row and nothing on the Shopify order.
 *
 * Every PayramPayment row records whether Payram confirmed it (`verifiedAt`),
 * and `sumReceivedUsd` counts confirmed rows only. Rows written before that
 * column existed are unconfirmed — some may hold forged amounts — and are
 * confirmed lazily with Payram, a few at a time, before they can count (MF-012).
 *
 * Rules: R-DB-TX (reads and writes that inform each other are transactional),
 * R-API-FOR-AGENTS (merchant-facing text says what to do next),
 * R-MALICIOUS-FLOW (MF-008, MF-011, MF-012).
 */
import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { convertFromUsd, convertFromUsdAtRate } from "~/utils/fx.server";
import { fetchPayramPayment } from "~/utils/payram.server";
import {
  addOrderTags,
  appendOrderNote,
  createGiftCard,
  fetchOrderSettlementContext,
  markOrderPaid,
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

/* ------------------------------------------------------------------ */
/* The gift-card slot — may a card still be issued for this order?     */
/* ------------------------------------------------------------------ */
//
// `PaymentMapping.giftCardId` is the one place that decides it:
//
//   null                      open: settlement may issue a card
//   "pending"                 a settlement is creating one right now
//   "manual_refund"           the merchant was told to refund this
//                             overpayment by hand; never issued automatically
//   gid://shopify/GiftCard/…  the card that was issued
//
// Every transition is a compare-and-set on the column, so two deliveries can
// never both decide the slot is theirs.

/**
 * Placeholder written while a gift card is being created, so a concurrent
 * webhook delivery cannot also decide the slot is free. Replaced by the real
 * Shopify GID on success.
 */
const GIFT_CARD_PENDING = "pending";

/**
 * The merchant has been told to refund this overpayment by hand — gift cards
 * were off, or Shopify refused the card. Settlement never issues one for the
 * order afterwards, even if the feature is switched on or the cause is fixed:
 * a merchant who did as told would otherwise refund the buyer twice.
 * Under-issuing is recoverable; double-issuing is not.
 *
 * Orders that releases up to 1.2.0 told to refund by hand — recorded then only
 * as the words in `syncError` — were moved to this value by the migration
 * 20261026120000_manual_refund_gift_card_slot.
 */
const GIFT_CARD_MANUAL_REFUND = "manual_refund";

export type GiftCardSlot = "open" | "pending" | "manual_refund" | "issued";

/** What `PaymentMapping.giftCardId` says about the order's gift card. */
export function giftCardSlot(giftCardId: string | null | undefined): GiftCardSlot {
  if (giftCardId == null || giftCardId === "") return "open";
  if (giftCardId === GIFT_CARD_PENDING) return "pending";
  if (giftCardId === GIFT_CARD_MANUAL_REFUND) return "manual_refund";
  return "issued";
}

/**
 * Close an open slot because the merchant is being told to refund by hand.
 * Single statement; a slot that already holds anything else is left alone.
 */
async function markGiftCardForManualRefund(
  shop: string,
  shopifyOrderId: string,
  from: null | typeof GIFT_CARD_PENDING,
): Promise<void> {
  await prisma.paymentMapping.updateMany({
    where: { shop, shopifyOrderId, giftCardId: from },
    data: { giftCardId: GIFT_CARD_MANUAL_REFUND, updatedAt: new Date() },
  });
}

/**
 * Money that arrived after the order's overpayment was already dealt with.
 * Said out loud rather than silently pocketed; never issued automatically.
 */
function furtherExcessWarnings(
  arrivedSince: Prisma.Decimal,
  reportedBefore: Prisma.Decimal,
  minimum: Prisma.Decimal,
): string[] {
  if (arrivedSince.lessThan(minimum)) return [];
  return [
    `A further ${money(arrivedSince, "USD")} arrived after the ${money(
      reportedBefore,
      "USD",
    )} overpayment was already refunded as a gift card. Refund the ` +
      "difference manually — no second card is issued automatically.",
  ];
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

/* ------------------------------------------------------------------ */
/* Confirmation — only what Payram confirms is money received          */
/* ------------------------------------------------------------------ */

/**
 * At most this many unconfirmed payments are looked up per settlement or
 * payment-page visit. Rows from before the confirmation column can include any
 * number of forged ones; nothing unconfirmed counts in the meantime, so the
 * bound only delays an honest older payment, it can never inflate a total.
 */
const PENDING_CONFIRMATIONS_PER_PASS = 5;

/** Re-check payment reads at most this many references for one order. */
const RECHECK_MAX_REFERENCES = 25;

/** Payram lookups in flight at once — a hanging Payram costs one timeout, not N. */
const LOOKUP_CONCURRENCY = 5;

/** What Payram said about one reference, judged for one order. */
export type PaymentConfirmation =
  | {
      referenceId: string;
      outcome: "confirmed";
      state: PayramState;
      filledAmountInUsd: string | null;
    }
  | {
      referenceId: string;
      /** Payram answered, and the reference is not this order's money. */
      outcome: "rejected";
      reason: "not_found" | "other_order";
      ownerCustomerId: string | null;
    }
  | {
      referenceId: string;
      /** No answer — try again later. Nothing may be concluded from it. */
      outcome: "unavailable";
      reason: string;
    };

type ConfirmedPayment = Extract<PaymentConfirmation, { outcome: "confirmed" }>;

/**
 * Ask Payram whether `referenceId` is real and belongs to this order.
 *
 * Verifying that the reference exists is not enough — it must also be THIS
 * order's money. Without the ownership check, a reference belonging to order A
 * could be posted with order B's customer_id and have its funds (and any
 * resulting gift card) credited to B.
 *
 * Never throws.
 */
export async function confirmPayramReference(
  shop: string,
  shopifyOrderId: string,
  referenceId: string,
): Promise<PaymentConfirmation> {
  let lookup: Awaited<ReturnType<typeof fetchPayramPayment>>;
  try {
    lookup = await fetchPayramPayment(shop, referenceId);
  } catch (err) {
    console.error("[payram-confirm] lookup failed:", err);
    return { referenceId, outcome: "unavailable", reason: "Payram could not be reached" };
  }

  if (lookup.status === "unavailable") {
    return { referenceId, outcome: "unavailable", reason: lookup.reason };
  }
  if (lookup.status === "not_found") {
    return { referenceId, outcome: "rejected", reason: "not_found", ownerCustomerId: null };
  }

  const expected = `shopify:${shop}:order:${shopifyOrderId}`;
  const owner = lookup.payment.customerId;
  const ownsOrder =
    owner != null &&
    (owner === expected ||
      // Top-ups are issued under a suffixed customerId for the same order.
      owner.startsWith(`${expected}:`));
  if (!ownsOrder) {
    return { referenceId, outcome: "rejected", reason: "other_order", ownerCustomerId: owner };
  }

  const state = normalizePayramState(lookup.payment.paymentState);
  return {
    referenceId,
    outcome: "confirmed",
    state,
    // OPEN means nothing has arrived yet and CANCELLED that nothing will.
    // Neither carries funds, so neither may carry an amount.
    filledAmountInUsd:
      state === "OPEN" || state === "CANCELLED" ? null : lookup.payment.filledAmountInUsd,
  };
}

/** Look up several references, a few at a time. Order of results matches input. */
async function confirmPayramReferences(
  shop: string,
  shopifyOrderId: string,
  referenceIds: string[],
): Promise<PaymentConfirmation[]> {
  const results: PaymentConfirmation[] = new Array(referenceIds.length);
  let next = 0;
  const worker = async () => {
    while (next < referenceIds.length) {
      const i = next++;
      results[i] = await confirmPayramReference(shop, shopifyOrderId, referenceIds[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LOOKUP_CONCURRENCY, referenceIds.length) }, worker),
  );
  return results;
}

/**
 * Everything received for an order: Payram-confirmed payments, ignoring
 * cancelled requests.
 *
 * The ONE implementation of the money-summing rule. Settlement and the buyer's
 * payment page both call it; two copies could drift, and the two disagreeing
 * about what an order has received is exactly the class of bug this connector
 * exists to remove. An unconfirmed row never counts — not even to tell a buyer
 * they owe nothing.
 */
export async function sumReceivedUsd(
  tx: Prisma.TransactionClient | typeof prisma,
  shop: string,
  shopifyOrderId: string,
): Promise<Prisma.Decimal> {
  const rows = await tx.payramPayment.findMany({
    where: { shop, shopifyOrderId },
    select: { filledAmountInUsd: true, state: true, verifiedAt: true, rejectedAt: true },
  });
  return rows
    .filter((r) => r.verifiedAt != null && r.rejectedAt == null && r.state !== "CANCELLED")
    .reduce(
      (sum, r) => sum.plus(new Prisma.Decimal(r.filledAmountInUsd ?? 0)),
      new Prisma.Decimal(0),
    );
}

/** Would this row change the total if Payram confirmed it as stored? */
function wouldCountIfConfirmed(row: {
  state: string | null;
  filledAmountInUsd: string | null;
}): boolean {
  if (row.state === "CANCELLED" || row.filledAmountInUsd == null) return false;
  try {
    return new Prisma.Decimal(row.filledAmountInUsd).greaterThan(0);
  } catch {
    return false;
  }
}

/**
 * Ask Payram about this order's payments that are still unconfirmed.
 *
 * These are rows written before the connector recorded confirmation, which may
 * include amounts from forged webhooks. Only rows that would add money if
 * confirmed are looked up (a cancelled or empty row counts nothing either way),
 * rejected rows are never retried here, and at most a few per call — so each
 * row is confirmed at most once and a forged one costs one lookup, ever.
 *
 * Network only; pass the result to `applyPaymentConfirmations` inside the
 * transaction that reads the total.
 */
export async function confirmPendingPayments(
  shop: string,
  shopifyOrderId: string,
  options: { except?: string[] } = {},
): Promise<PaymentConfirmation[]> {
  const except = options.except ?? [];
  const rows = await prisma.payramPayment.findMany({
    where: { shop, shopifyOrderId },
    orderBy: { createdAt: "asc" },
  });
  const pending = rows
    .filter(
      (r) =>
        r.verifiedAt == null &&
        r.rejectedAt == null &&
        !except.includes(r.payramReferenceId) &&
        wouldCountIfConfirmed(r),
    )
    .slice(0, PENDING_CONFIRMATIONS_PER_PASS)
    .map((r) => r.payramReferenceId);
  return pending.length ? confirmPayramReferences(shop, shopifyOrderId, pending) : [];
}

/**
 * Record a payment whose figures Payram has just confirmed belong to this order.
 *
 * Payram decides which order a reference belongs to, so the row is (re)assigned
 * to this order: one first written under the wrong order by a forged webhook
 * moves to its real owner here. The tx hash is only ever set, never cleared —
 * Payram re-sends every three seconds and `payment_info` is absent on some
 * deliveries.
 */
export async function recordConfirmedPayment(
  tx: Prisma.TransactionClient,
  payment: {
    shop: string;
    shopifyOrderId: string;
    referenceId: string;
    state: PayramState;
    filledAmountInUsd: string | null;
    txHash: string | null;
  },
): Promise<void> {
  const { shop, shopifyOrderId, referenceId, state, filledAmountInUsd, txHash } = payment;
  const now = new Date();
  await tx.payramPayment.upsert({
    where: { payramReferenceId: referenceId },
    create: {
      shop,
      shopifyOrderId,
      payramReferenceId: referenceId,
      state,
      filledAmountInUsd,
      txHash,
      verifiedAt: now,
    },
    update: {
      shop,
      shopifyOrderId,
      state,
      filledAmountInUsd,
      verifiedAt: now,
      rejectedAt: null,
      ...(txHash ? { txHash } : {}),
      updatedAt: now,
    },
  });
}

/** What applying Payram's answers did to an order's payments. */
export interface ConfirmationTally {
  /** Rows whose contribution to the total may have changed. */
  changed: number;
  /** References Payram said are not this order's. They do not count. */
  rejected: string[];
  /** Unconfirmed references Payram did not answer for. Not counted yet. */
  uncounted: string[];
  /** Confirmed references Payram did not answer for. Their last confirmed figures stand. */
  stale: string[];
}

/**
 * Write Payram's answers about an order's payments.
 *
 * Confirmed figures are recorded. A rejection marks an unconfirmed row
 * `rejectedAt` so it never counts and is never looked up automatically again;
 * a row Payram confirmed earlier is never un-confirmed by a later "not found",
 * which is far more likely a misconfigured URL than a vanished payment.
 *
 * `refresh` (Re-check payment) overwrites confirmed rows with Payram's current
 * figures. Without it only rows that are still unconfirmed are written, and
 * only if they still are — a concurrent webhook that confirmed newer figures
 * in the meantime wins (compare-and-set on `verifiedAt`).
 *
 * Call inside the transaction that reads the total (R-DB-TX).
 */
export async function applyPaymentConfirmations(
  tx: Prisma.TransactionClient,
  shop: string,
  shopifyOrderId: string,
  confirmations: PaymentConfirmation[],
  options: { refresh?: boolean } = {},
): Promise<ConfirmationTally> {
  const tally: ConfirmationTally = { changed: 0, rejected: [], uncounted: [], stale: [] };
  if (confirmations.length === 0) return tally;

  const rows = await tx.payramPayment.findMany({ where: { shop, shopifyOrderId } });
  const byReference = new Map(rows.map((r) => [r.payramReferenceId, r]));
  const now = new Date();

  for (const c of confirmations) {
    const row = byReference.get(c.referenceId);
    const confirmedEarlier = row?.verifiedAt != null;

    if (c.outcome === "confirmed" && c.state !== "UNDEFINED") {
      if (options.refresh) {
        await recordConfirmedPayment(tx, {
          shop,
          shopifyOrderId,
          referenceId: c.referenceId,
          state: c.state,
          filledAmountInUsd: c.filledAmountInUsd,
          txHash: null,
        });
        tally.changed += 1;
      } else {
        const res = await tx.payramPayment.updateMany({
          where: { payramReferenceId: c.referenceId, verifiedAt: null },
          data: {
            shop,
            shopifyOrderId,
            state: c.state,
            filledAmountInUsd: c.filledAmountInUsd,
            verifiedAt: now,
            rejectedAt: null,
          },
        });
        tally.changed += res.count;
      }
      continue;
    }

    if (c.outcome === "rejected" && !confirmedEarlier) {
      if (row && row.rejectedAt == null) {
        await tx.payramPayment.updateMany({
          where: { payramReferenceId: c.referenceId, shop, shopifyOrderId, verifiedAt: null },
          data: { rejectedAt: now },
        });
        // The audit trail: what was claimed, and why it will never count.
        console.warn(
          `[payram-confirm] ${shop} order ${shopifyOrderId}: reference ${c.referenceId} ` +
            `rejected by Payram (${c.reason === "other_order" ? `belongs to ${String(c.ownerCustomerId)}` : "no such payment"}); ` +
            `it claimed ${String(row.state)} ${String(row.filledAmountInUsd)} USD and will not count`,
        );
      }
      tally.rejected.push(c.referenceId);
      continue;
    }

    // No usable answer: unavailable, an unrecognised state, or Payram now
    // disowning a reference it confirmed before.
    (confirmedEarlier ? tally.stale : tally.uncounted).push(c.referenceId);
  }

  return tally;
}

/** Merchant-facing sentences for what confirmation found. Empty when all is well. */
function describeConfirmationTally(tally: ConfirmationTally): string[] {
  const list = (refs: string[]) =>
    refs.slice(0, 3).join(", ") + (refs.length > 3 ? ` and ${refs.length - 3} more` : "");
  const lines: string[] = [];
  if (tally.rejected.length) {
    lines.push(
      `${tally.rejected.length} payment message(s) recorded for this order could not be confirmed ` +
        `with Payram — Payram has no such payment for this order — so they do not count toward it ` +
        `(${list(tally.rejected)}). If the customer says they paid, check the order in Payram.`,
    );
  }
  if (tally.uncounted.length) {
    lines.push(
      `${tally.uncounted.length} payment(s) for this order could not be confirmed with Payram just ` +
        "now, so they are not counted yet. Use Re-check payment once Payram is reachable.",
    );
  }
  if (tally.stale.length) {
    lines.push(
      `${tally.stale.length} payment reference(s) could not be read from Payram just now; the ` +
        "figures Payram confirmed for them earlier are used.",
    );
  }
  return lines;
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
 * Only for figures Payram has confirmed belong to this order: `verified: false`
 * is refused outright, with nothing recorded and nothing sent to Shopify.
 * Before totting up, the order's other still-unconfirmed payments are confirmed
 * with Payram (a few per call), so the total is made of confirmed rows only.
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
  /**
   * True only when Payram itself confirmed these figures belong to this order
   * (see `confirmPayramReference`). False is refused: nothing is recorded.
   */
  verified: boolean;
  /**
   * Re-run the Shopify side even when nothing has changed.
   *
   * Repeat webhook deliveries short-circuit to avoid burning rate limit, but a
   * merchant pressing "Re-check payment" is asking us to try again — usually
   * because marking the order paid failed the first time.
   */
  force?: boolean;
  /**
   * Payram's answers for this order's OTHER references, already fetched by the
   * caller — Re-check payment reads every reference, and these refresh rows
   * Payram confirmed before. When omitted, settlement confirms the order's
   * still-unconfirmed payments itself.
   */
  otherReferences?: PaymentConfirmation[];
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
    force = false,
    otherReferences,
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

  // An unconfirmed message changes no money row and nothing on the Shopify
  // order (MF-012). The webhook already refuses to call us with one; this is
  // the function that writes money rows, tags orders and mints value, so it
  // refuses too rather than trusting every caller to have checked.
  if (!verified) {
    return {
      state,
      receivedUsd: "0.00",
      invoicedUsd: null,
      balanceUsd: null,
      settled: false,
      giftCardIssued: false,
      note: null,
      warnings: [
        "This payment could not be confirmed with Payram, so nothing was recorded and the " +
          "order was left untouched. If the customer paid, use Re-check payment.",
      ],
    };
  }

  // Older rows for this order may be unconfirmed — possibly forged. Ask Payram
  // about them now (network, so outside the transaction); the answers are
  // written below in the same transaction that reads the total.
  const others =
    otherReferences ??
    (await confirmPendingPayments(shop, shopifyOrderId, { except: [referenceId] }));

  // --- Record this reference, then recompute the total from all of them ---
  // R-DB-TX: the upserts and the aggregate read are one atomic unit, so a
  // concurrent webhook cannot make the sum disagree with the rows.
  const { received, mapping, unchanged, tally } = await prisma.$transaction(async (tx) => {
    // Payram re-sends a webhook every 3 seconds for the whole confirmation
    // window (webhook_processor_job.go ticks at 3s and re-sends for every
    // confirming deposit). A 12-confirmation BTC payment therefore arrives
    // thousands of times. Detect "nothing actually changed" BEFORE overwriting
    // the row, so repeat deliveries cost one query instead of four network calls.
    //
    // "Nothing changed" requires the row to have been CONFIRMED for this very
    // order already. A row from before confirmation existed — or one a forged
    // webhook put under the wrong order — can carry the same figures and still
    // change the total the moment it is confirmed here.
    const prior = await tx.payramPayment.findUnique({
      where: { payramReferenceId: referenceId },
    });
    const same =
      prior !== null &&
      prior.verifiedAt != null &&
      prior.rejectedAt == null &&
      prior.shop === shop &&
      prior.shopifyOrderId === shopifyOrderId &&
      prior.state === state &&
      prior.filledAmountInUsd === filledAmountInUsd;

    await recordConfirmedPayment(tx, {
      shop,
      shopifyOrderId,
      referenceId,
      state,
      filledAmountInUsd,
      txHash,
    });

    const t = await applyPaymentConfirmations(tx, shop, shopifyOrderId, others, {
      refresh: otherReferences !== undefined,
    });

    // One implementation of the money-summing rule, shared with the payment page
    // — the two must never be able to disagree about what an order has received.
    const total = await sumReceivedUsd(tx, shop, shopifyOrderId);

    const m = await tx.paymentMapping.findUnique({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
    });

    return { received: total, mapping: m, unchanged: same && t.changed === 0, tally: t };
  });

  warnings.push(...describeConfirmationTally(tally));

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
  // A failed mark-paid always pushes a warning, which `persist` writes to
  // syncError — so `!mapping.syncError` already forces the retry. An extra
  // "is Shopify paid" clause would add nothing for those, and for rows that
  // predate the column it would defeat the short-circuit entirely, running four
  // Admin API calls every three seconds for the whole confirmation window.
  //
  // The total must also be the one settlement last acted on. It moves without
  // this reference changing when an older payment is confirmed or rejected —
  // here, or by the payment page — and the Shopify order must follow it.
  if (
    !force &&
    unchanged &&
    warnings.length === 0 &&
    mapping.paymentState === state &&
    !mapping.syncError &&
    mapping.filledAmountInUsd === received.toFixed(2)
  ) {
    // `settled` must mean the same thing here as on the first delivery. Deriving
    // it from the balance sign would report a shortfall absorbed by the
    // tolerance as unsettled on every re-delivery, while the order stays tagged
    // paid — two answers for one order. Read back what settlement recorded.
    return {
      state,
      receivedUsd: received.toFixed(2),
      invoicedUsd: invoiced.toFixed(2),
      balanceUsd: mapping.balanceUsd ?? null,
      settled: mapping.shopifyFinancialStatus === TAG_PAID,
      giftCardIssued: giftCardSlot(mapping.giftCardId) === "issued",
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

  if (!orderContext) {
    // appendOrderNote treats a null existing note as "empty" and writes ours as
    // the whole note. Without a successful read we cannot know what the merchant
    // had written there, and overwriting it would be silent data loss.
    warnings.push(
      "The order note was not updated because the existing note could not be read. " +
        "Use Re-check payment to try again.",
    );
  } else {
    try {
      await appendOrderNote(
        shop,
        accessToken,
        shopifyOrderId,
        orderContext.note,
        note,
      );
    } catch (err) {
      warnings.push(
        `Could not add the order note: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- Make Shopify's own status agree ---
  // Tags are an audit trail; they are invisible to payouts, order filters,
  // reports and fulfilment apps. Without this the merchant sees "Payment
  // pending" on an order we have confirmed was paid, and has to take our word
  // for it over their own admin.
  //
  // Best-effort: a failure here must never undo a settled payment. The tag and
  // note still stand, and the merchant is told what to do.
  // Marking an order PAID is not reversible through the API and is what
  // payouts, order filters and fulfilment apps read. It is only reachable with
  // Payram-confirmed figures: unverified payments were refused above.
  let markedPaidAt: Date | null = mapping.shopifyMarkedPaidAt ?? null;
  if (settled && !markedPaidAt) {
    try {
      const res = await markOrderPaid(shop, accessToken, shopifyOrderId);
      if (res.ok) {
        markedPaidAt = new Date();
        console.info("[payram-settle] marked order paid in Shopify", {
          shopifyOrderId,
          alreadyPaid: res.alreadyPaid,
          financialStatus: res.financialStatus,
        });
      } else {
        warnings.push(
          `The payment is confirmed and the order is tagged, but Shopify would not mark it ` +
            `paid: ${res.error}. Open the order and use "Mark as paid".`,
        );
      }
    } catch (err) {
      warnings.push(
        `The payment is confirmed and the order is tagged, but marking it paid in Shopify ` +
          `failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Open the order and use "Mark as paid". If this keeps happening, check that whoever ` +
          `installed the app has the "mark orders as paid" staff permission.`,
      );
    }
  }

  // --- Overpayment: return the excess as a gift card ---
  let giftCardIssued = false;
  const giftFields: Record<string, string | null> = {};

  if (isOver) {
    const minimum = safeDecimal(config?.giftCardMinimumUsd, "1.00");
    const slot = giftCardSlot(mapping.giftCardId);
    // The overpayment settlement last reported for this order, to say how
    // much of today's is new. An order that was short before reported none.
    const reportedBefore = Prisma.Decimal.max(safeDecimal(mapping.balanceUsd, "0"), 0);
    const arrivedSince = balance.minus(reportedBefore);

    // Every figure in `balance` is Payram-confirmed: unverified payments were
    // refused above, and unconfirmed rows are not in the total.
    if (slot === "manual_refund") {
      // The merchant was told to refund this by hand. Whatever has changed
      // since — gift cards switched on, the cause of a refusal fixed — a card
      // now would refund the buyer a second time.
      warnings.push(
        `Overpaid by ${money(balance, "USD")}. This overpayment was left for you to refund by ` +
          "hand, so no gift card is issued for it automatically. Refund it from Shopify Admin " +
          "if you have not already." +
          (reportedBefore.greaterThan(0) && arrivedSince.greaterThan(0)
            ? ` ${money(arrivedSince, "USD")} of it arrived after ${money(
                reportedBefore,
                "USD",
              )} was reported.`
            : ""),
      );
    } else if (slot === "issued") {
      // A card exists for this order. Never issue a second one automatically
      // — a retried webhook must not mint value twice.
      giftCardIssued = true;
      warnings.push(...furtherExcessWarnings(arrivedSince, reportedBefore, minimum));
    } else if (slot === "pending") {
      // Another delivery is creating the card right now and reports it.
    } else if (!config?.autoGiftCardOnOverpayment) {
      // Closing the slot is what makes "refund manually" safe to follow.
      await markGiftCardForManualRefund(shop, shopifyOrderId, null);
      warnings.push(
        `Overpaid by ${money(balance, "USD")}. Automatic gift cards are off, so this ` +
          "must be refunded manually — switching them on later does not issue one for this " +
          "order. Enable it in the Payram app settings to refund future overpayments automatically.",
      );
    } else if (balance.lessThan(minimum)) {
      warnings.push(
        `Overpaid by ${money(balance, "USD")}, which is below the ${money(minimum, "USD")} ` +
          "gift card minimum. No gift card was issued.",
      );
    } else if (
      // Compare-and-set claim. The read of `mapping.giftCardId` above happened
      // before the Shopify calls, so two concurrent deliveries could both pass
      // it and both mint real money. Reserve the slot first; whoever loses the
      // race issues nothing.
      (
        await prisma.paymentMapping.updateMany({
          where: { shop, shopifyOrderId, giftCardId: null },
          data: { giftCardId: GIFT_CARD_PENDING, updatedAt: new Date() },
        })
      ).count === 0
    ) {
      // A concurrent delivery claimed the slot after we read it; it reports.
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
          currencyCode: giftCurrency,
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
            // Only reached when orderContext loaded, so this is never a blind null.
            orderContext?.note ?? "",
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
        // The merchant is told to refund by hand, so the slot closes for good
        // — from `pending` only, never over a real card id. Reopening it (as
        // releases up to 1.2.0 did) let the next delivery or Re-check mint a
        // card for an overpayment the merchant had already refunded.
        await markGiftCardForManualRefund(shop, shopifyOrderId, GIFT_CARD_PENDING).catch(
          (markErr) =>
            console.error(
              "[payram-settle] could not record the manual refund; the slot stays reserved:",
              markErr,
            ),
        );
        warnings.push(
          `Overpaid by ${money(balance, "USD")} but the gift card could not be created: ${
            err instanceof Error ? err.message : String(err)
          }. Refund manually — no gift card will be issued for this order automatically.`,
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
    shopifyMarkedPaidAt: markedPaidAt,
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

/** What Re-check payment found, for the merchant. */
export interface RecheckResult {
  /** Null when Payram confirmed none of the order's references. */
  outcome: SettlementOutcome | null;
  /** References Payram did not answer for. */
  unreachable: string[];
  /** References Payram said are not this order's. They do not count. */
  notConfirmed: string[];
}

/**
 * The merchant's "Re-check payment": read every reference this order has from
 * Payram and settle the order on Payram's figures alone.
 *
 * Webhooks are the normal path, but they can be missing (no webhook configured
 * in Payram), late, or exhausted after retries. This is the self-service repair,
 * and the one path that looks again at references Payram rejected before — a
 * wrong Payram URL rejects everything, and fixing it must be able to undo that.
 * A reference Payram does not confirm for this order never counts, whatever is
 * stored for it.
 *
 * Re-check EVERY reference, not just the latest: a top-up arrives under a
 * brand-new Payram reference, so an order underpaid and then topped up has more
 * than one, and refreshing only the most recent would leave it reading short.
 */
export async function recheckOrder(params: {
  shop: string;
  shopifyOrderId: string;
  accessToken: string;
  /** The reference of the order's most recent payment link. */
  latestReferenceId: string;
}): Promise<RecheckResult> {
  const { shop, shopifyOrderId, accessToken, latestReferenceId } = params;

  const rows = await prisma.payramPayment.findMany({
    where: { shop, shopifyOrderId },
    select: { payramReferenceId: true, rejectedAt: true },
    orderBy: { createdAt: "asc" },
  });
  // Rejected references last, so a pile of forged ones cannot crowd real
  // payments out of the bounded read.
  const references = Array.from(
    new Set([
      latestReferenceId,
      ...rows.filter((r) => r.rejectedAt == null).map((r) => r.payramReferenceId),
      ...rows.filter((r) => r.rejectedAt != null).map((r) => r.payramReferenceId),
    ]),
  ).slice(0, RECHECK_MAX_REFERENCES);

  const confirmations = await confirmPayramReferences(shop, shopifyOrderId, references);
  const usable = confirmations.filter(
    (c): c is ConfirmedPayment => c.outcome === "confirmed" && c.state !== "UNDEFINED",
  );

  if (usable.length === 0) {
    // Nothing to settle on. Still record Payram's rejections, so forged rows
    // stop being looked up on every payment-page visit.
    const tally = await prisma.$transaction((tx) =>
      applyPaymentConfirmations(tx, shop, shopifyOrderId, confirmations, { refresh: true }),
    );
    return {
      outcome: null,
      unreachable: [...tally.uncounted, ...tally.stale],
      notConfirmed: tally.rejected,
    };
  }

  // The last confirmed reference anchors the settlement (its state becomes the
  // order's displayed state, as when each reference was settled in turn);
  // every other answer is applied in the same transaction.
  const anchor = usable[usable.length - 1];
  const outcome = await settleOrder({
    shop,
    shopifyOrderId,
    referenceId: anchor.referenceId,
    state: anchor.state,
    filledAmountInUsd: anchor.filledAmountInUsd,
    txHash: null,
    accessToken,
    verified: true,
    // The merchant explicitly asked, so redo the Shopify side even if nothing
    // about the payment changed. This is what repairs an order that settled
    // but failed to be marked paid.
    force: true,
    otherReferences: confirmations.filter((c) => c !== anchor),
  });

  return {
    outcome,
    unreachable: confirmations
      .filter((c) => c.outcome === "unavailable" || (c.outcome === "confirmed" && c.state === "UNDEFINED"))
      .map((c) => c.referenceId),
    notConfirmed: confirmations.filter((c) => c.outcome === "rejected").map((c) => c.referenceId),
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
