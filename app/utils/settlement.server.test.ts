/**
 * Settlement tests.
 *
 * The regressions locked down here:
 *  - Payram sends FILLED / PARTIALLY_FILLED / OVER_FILLED. The connector used to
 *    compare against ["paid","confirmed","closed","completed"], so no order was
 *    ever tagged paid.
 *  - A short payment must never be treated as settled.
 *  - A top-up arrives under a NEW Payram reference; its funds must still count
 *    towards the original order, and a retried webhook must not double-count.
 *  - Only figures Payram confirmed count (MF-012). An unverified payment is
 *    refused outright, and a row nobody confirmed never joins the total.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { db, admin, fx, store } = vi.hoisted(() => {
  const db = {
    payments: new Map<string, Record<string, unknown>>(),
    mapping: null as Record<string, unknown> | null,
    config: null as Record<string, unknown> | null,
    updates: [] as Record<string, unknown>[],
  };
  const admin = {
    fetchOrderSettlementContext: vi.fn(),
    addOrderTags: vi.fn(),
    appendOrderNote: vi.fn(),
    createGiftCard: vi.fn(),
    markOrderPaid: vi.fn(),
  };
  const fx = {
    convertFromUsd: vi.fn(),
    convertFromUsdAtRate: vi.fn(),
  };
  // In-memory stand-in for Prisma. A real store (not bare stubs) so the
  // accumulation and idempotency tests actually mean something.
  const store = {
    payramPayment: {
      findUnique: async ({ where }: any) =>
        db.payments.get(where.payramReferenceId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = db.payments.get(where.payramReferenceId);
        db.payments.set(where.payramReferenceId, {
          ...(existing ?? create),
          ...(existing ? update : {}),
        });
      },
      findMany: async ({ where }: any) =>
        [...db.payments.values()].filter(
          (p) => p.shop === where.shop && p.shopifyOrderId === where.shopifyOrderId,
        ),
    },
    paymentMapping: {
      findUnique: async () => db.mapping,
      update: async ({ data }: any) => {
        db.updates.push(data);
        db.mapping = { ...(db.mapping ?? {}), ...data };
        return db.mapping;
      },
      // Honours the `where` clause, so the gift-card compare-and-set claim is
      // actually exercised rather than assumed to succeed.
      updateMany: async ({ where, data }: any) => {
        const m = db.mapping;
        if (!m) return { count: 0 };
        for (const k of Object.keys(where)) {
          if (k === "shop" || k === "shopifyOrderId") continue;
          const expected = where[k];
          const actual = (m as any)[k] ?? null;
          if (expected === null ? actual !== null : actual !== expected) {
            return { count: 0 };
          }
        }
        db.updates.push(data);
        db.mapping = { ...m, ...data };
        return { count: 1 };
      },
    },
    merchantConfig: { findUnique: async () => db.config },
  };
  return { db, admin, fx, store };
});

vi.mock("~/db.server", () => ({
  default: {
    ...store,
    $transaction: async (fn: (tx: typeof store) => unknown) => fn(store),
  },
}));
vi.mock("~/utils/shopify-admin.server", () => admin);
vi.mock("~/utils/fx.server", () => fx);

// Settlement asks Payram about the order's still-unconfirmed payments. These
// tests never contact a real Payram: by default it cannot be reached.
const payram = vi.hoisted(() => ({ fetchPayramPayment: vi.fn() }));
vi.mock("~/utils/payram.server", () => payram);

import {
  effectiveTolerance,
  giftCardSlot,
  normalizePayramState,
  settleOrder,
  TAG_PAID,
  TAG_PARTIAL,
  TAG_OVERPAID,
} from "./settlement.server";

const SHOP = "demo.myshopify.com";
const ORDER = "1001";

/** Order invoiced at €50.00 → $54.22 at rate 1.084481. */
function seedMapping(overrides: Record<string, unknown> = {}) {
  db.mapping = {
    id: "map_1",
    shop: SHOP,
    shopifyOrderId: ORDER,
    amountInUsd: "54.22",
    orderCurrency: "EUR",
    fxRate: "1.084481",
    giftCardId: null,
    ...overrides,
  };
}

async function settle(
  referenceId: string,
  state: never,
  filled: string,
  verified = true,
) {
  return settleOrder({
    shop: SHOP,
    shopifyOrderId: ORDER,
    referenceId,
    state,
    filledAmountInUsd: filled,
    txHash: "0xabc",
    accessToken: "token",
    verified,
  });
}

beforeEach(() => {
  db.payments.clear();
  db.updates.length = 0;
  db.mapping = null;
  db.config = {
    autoGiftCardOnOverpayment: true,
    giftCardMinimumUsd: "5.00",
    settlementTolerancePercent: "1.0",
    settlementToleranceMinUsd: "1.00",
  };

  vi.clearAllMocks();
  payram.fetchPayramPayment.mockResolvedValue({
    status: "unavailable",
    reason: "Payram could not be reached",
  });
  admin.fetchOrderSettlementContext.mockResolvedValue({
    orderName: "#1001",
    note: null,
    customerId: "gid://shopify/Customer/5",
    shopCurrencyCode: "EUR",
  });
  admin.addOrderTags.mockResolvedValue(undefined);
  admin.markOrderPaid.mockResolvedValue({
    ok: true,
    financialStatus: "PAID",
    alreadyPaid: false,
  });
  admin.appendOrderNote.mockResolvedValue(undefined);
  admin.createGiftCard.mockResolvedValue({
    id: "gid://shopify/GiftCard/9",
    lastCharacters: "4f2a",
    amount: "5.33",
    currencyCode: "EUR",
    notified: true,
  });
  // Real behaviour of the pure helper: usd / rate.
  fx.convertFromUsdAtRate.mockImplementation((usd: never, rate: never) => {
    const { Prisma } = require("@prisma/client");
    return new Prisma.Decimal(usd)
      .dividedBy(new Prisma.Decimal(rate))
      .toDecimalPlaces(2);
  });
  fx.convertFromUsd.mockImplementation(async (usd: never) => {
    const { Prisma } = require("@prisma/client");
    return new Prisma.Decimal(usd).toDecimalPlaces(2);
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("normalizePayramState — the status-mismatch regression", () => {
  it.each(["FILLED", "PARTIALLY_FILLED", "OVER_FILLED", "OPEN", "CANCELLED"])(
    "recognises Payram's own state %s",
    (s) => {
      expect(normalizePayramState(s)).toBe(s);
    },
  );

  it("recognises FILLED, which the old PAID_STATUSES set missed entirely", () => {
    // The bug: "filled" was not in ["paid","confirmed","closed","completed"].
    expect(normalizePayramState("FILLED")).toBe("FILLED");
  });

  it.each(["paid", "confirmed", "closed", "completed"])(
    "still maps legacy alias %s to FILLED",
    (s) => {
      expect(normalizePayramState(s)).toBe("FILLED");
    },
  );

  it.each([undefined, null, "", "weird", "PENDING"])(
    "fails safe on %s rather than assuming payment",
    (s) => {
      expect(normalizePayramState(s)).toBe("UNDEFINED");
    },
  );
});

describe("settleOrder — exact payment", () => {
  it("tags the order paid", async () => {
    seedMapping();
    const out = await settle("ref-1", "FILLED" as never, "54.22");

    expect(out.settled).toBe(true);
    expect(out.balanceUsd).toBe("0.00");
    expect(admin.addOrderTags).toHaveBeenCalledWith(
      SHOP,
      "token",
      ORDER,
      [TAG_PAID],
    );
  });

  it("treats a one-cent rounding difference as settled", async () => {
    seedMapping();
    const out = await settle("ref-1", "FILLED" as never, "54.21");

    expect(out.settled).toBe(true);
    expect(admin.addOrderTags).toHaveBeenCalledWith(SHOP, "token", ORDER, [
      TAG_PAID,
    ]);
  });
});

describe("settleOrder — underpayment", () => {
  it("does NOT tag the order paid", async () => {
    seedMapping();
    const out = await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");

    expect(out.settled).toBe(false);
    expect(admin.addOrderTags).toHaveBeenCalledWith(SHOP, "token", ORDER, [
      TAG_PARTIAL,
    ]);
    const tags = admin.addOrderTags.mock.calls[0][3] as string[];
    expect(tags).not.toContain(TAG_PAID);
  });

  it("states the shortfall in USD and the order currency", async () => {
    seedMapping();
    await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");

    const note = admin.appendOrderNote.mock.calls[0][4] as string;
    expect(note).toContain("14.22 USD"); // 54.22 - 40.00
    expect(note).toContain("13.11 EUR"); // 14.22 / 1.084481
    expect(note).toMatch(/do not fulfil/i);
  });

  it("issues no gift card", async () => {
    seedMapping();
    await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");
    expect(admin.createGiftCard).not.toHaveBeenCalled();
  });
});

describe("settleOrder — top-ups under a new reference", () => {
  it("sums a second payment towards the same order and settles it", async () => {
    seedMapping();

    const first = await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");
    expect(first.settled).toBe(false);

    // payram-core creates a NEW payment request for the top-up.
    const second = await settle("ref-2", "FILLED" as never, "14.22");

    expect(second.receivedUsd).toBe("54.22");
    expect(second.settled).toBe(true);
    expect(admin.addOrderTags).toHaveBeenLastCalledWith(SHOP, "token", ORDER, [
      TAG_PAID,
    ]);
  });

  it("does not double-count a retried webhook for the same reference", async () => {
    seedMapping();

    await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");
    const retry = await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");

    expect(retry.receivedUsd).toBe("40.00");
    expect(retry.settled).toBe(false);
  });

  it("ignores cancelled payment requests when summing", async () => {
    seedMapping();
    await settle("ref-1", "FILLED" as never, "54.22");
    // A cancelled request contributed no funds.
    db.payments.set("ref-x", {
      shop: SHOP,
      shopifyOrderId: ORDER,
      state: "CANCELLED",
      filledAmountInUsd: "99.00",
    });
    const out = await settle("ref-1", "FILLED" as never, "54.22");
    expect(out.receivedUsd).toBe("54.22");
  });
});

describe("settleOrder — overpayment", () => {
  it("tags paid and overpaid, and issues a gift card for the excess", async () => {
    seedMapping();
    const out = await settle("ref-1", "OVER_FILLED" as never, "60.00");

    expect(out.settled).toBe(true);
    expect(out.giftCardIssued).toBe(true);
    expect(admin.addOrderTags).toHaveBeenCalledWith(SHOP, "token", ORDER, [
      TAG_PAID,
      TAG_OVERPAID,
    ]);

    // 60.00 - 54.22 = 5.78 USD → /1.084481 = 5.33 EUR
    const args = admin.createGiftCard.mock.calls[0][2] as { amount: string };
    expect(args.amount).toBe("5.33");
  });

  it("issues the card in the currency its amount was computed in", async () => {
    seedMapping();
    await settle("ref-1", "OVER_FILLED" as never, "60.00");

    // Admin API 2026-07+ takes initialAmount = amount + currency. The amount
    // above is EUR because the shop currency is EUR; the card must be EUR too.
    const args = admin.createGiftCard.mock.calls[0][2] as {
      amount: string;
      currencyCode: string;
    };
    expect(args).toMatchObject({ amount: "5.33", currencyCode: "EUR" });
  });

  it("converts at the live rate and issues in the shop currency when it differs from the order's", async () => {
    // A Markets order presented in EUR on a USD shop: gift cards are shop money.
    admin.fetchOrderSettlementContext.mockResolvedValue({
      orderName: "#1001",
      note: null,
      customerId: "gid://shopify/Customer/5",
      shopCurrencyCode: "USD",
    });
    seedMapping();
    await settle("ref-1", "OVER_FILLED" as never, "60.00");

    expect(fx.convertFromUsd).toHaveBeenCalledWith(expect.anything(), "USD");
    const args = admin.createGiftCard.mock.calls[0][2] as {
      amount: string;
      currencyCode: string;
    };
    expect(args).toMatchObject({ amount: "5.78", currencyCode: "USD" });
  });

  it("attaches the customer so Shopify emails the card", async () => {
    seedMapping();
    await settle("ref-1", "OVER_FILLED" as never, "60.00");

    const args = admin.createGiftCard.mock.calls[0][2] as {
      customerId: string | null;
    };
    expect(args.customerId).toBe("gid://shopify/Customer/5");
  });

  it("skips dust below the configured minimum", async () => {
    seedMapping();
    // +$3.00: past the $1.00 tolerance, below the $5.00 gift-card minimum.
    const out = await settle("ref-1", "OVER_FILLED" as never, "57.22");

    expect(out.settled).toBe(true);
    expect(out.giftCardIssued).toBe(false);
    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect(out.warnings.join(" ")).toMatch(/below the .* minimum/i);
  });

  it("does nothing automatic when the merchant has the feature off", async () => {
    seedMapping();
    db.config = {
      autoGiftCardOnOverpayment: false,
      giftCardMinimumUsd: "5.00",
      settlementTolerancePercent: "1.0",
      settlementToleranceMinUsd: "1.00",
    };

    const out = await settle("ref-1", "OVER_FILLED" as never, "60.00");

    expect(out.giftCardIssued).toBe(false);
    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect(out.warnings.join(" ")).toMatch(/refunded manually/i);
  });

  it("does not issue a second card if one already exists", async () => {
    seedMapping({ giftCardId: "gid://shopify/GiftCard/9" });
    const out = await settle("ref-1", "OVER_FILLED" as never, "60.00");

    expect(out.giftCardIssued).toBe(true);
    expect(admin.createGiftCard).not.toHaveBeenCalled();
  });

  it("still settles the order when the gift card fails", async () => {
    seedMapping();
    admin.createGiftCard.mockRejectedValue(new Error("gift cards not enabled"));

    const out = await settle("ref-1", "OVER_FILLED" as never, "60.00");

    expect(out.settled).toBe(true);
    expect(out.giftCardIssued).toBe(false);
    expect(out.warnings.join(" ")).toMatch(/refund manually/i);
  });
});

describe("settleOrder — degraded cases", () => {
  it("never throws when Shopify tagging fails", async () => {
    seedMapping();
    admin.addOrderTags.mockRejectedValue(new Error("PCD blocked"));

    const out = await settle("ref-1", "FILLED" as never, "54.22");

    expect(out.settled).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/could not tag/i);
  });

  it("flags an order with no recorded invoice amount instead of guessing", async () => {
    seedMapping({ amountInUsd: null });

    const out = await settle("ref-1", "FILLED" as never, "54.22");

    expect(out.settled).toBe(false);
    expect(out.invoicedUsd).toBeNull();
    expect(admin.addOrderTags).not.toHaveBeenCalled();
    expect(out.warnings.join(" ")).toMatch(/manually/i);
  });
});

describe("settleOrder — unverified webhooks never mint value", () => {
  // These two used to assert the hole itself: an unverified OVER_FILLED was
  // reported settled, and an unverified FILLED was recorded and tagged paid.
  // Recording it is what let a forged $150 join a real $1 and get the order
  // marked paid with a $51 gift card (MF-012), so both now assert refusal.
  it("refuses to issue a gift card when Payram could not confirm the payment", async () => {
    seedMapping();

    const out = await settle("ref-1", "OVER_FILLED" as never, "60.00", false);

    expect(out.settled).toBe(false);
    expect(out.giftCardIssued).toBe(false);
    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect(out.warnings.join(" ")).toMatch(/could not be confirmed with Payram/i);
  });

  it("records nothing and touches nothing on Shopify for an unverified payment", async () => {
    seedMapping();

    const out = await settle("ref-1", "FILLED" as never, "54.22", false);

    expect(out.settled).toBe(false);
    expect(db.payments.size).toBe(0);
    expect(db.updates).toHaveLength(0);
    expect(admin.addOrderTags).not.toHaveBeenCalled();
    expect(admin.appendOrderNote).not.toHaveBeenCalled();
    expect(admin.markOrderPaid).not.toHaveBeenCalled();
    expect(admin.fetchOrderSettlementContext).not.toHaveBeenCalled();
  });

  it("a later verified payment does not inherit the refused amount", async () => {
    seedMapping();
    await settle("ref-forged", "OVER_FILLED" as never, "150.00", false);

    const real = await settle("ref-1", "PARTIALLY_FILLED" as never, "1.00");

    expect(real.receivedUsd).toBe("1.00");
    expect(real.settled).toBe(false);
    expect(admin.markOrderPaid).not.toHaveBeenCalled();
    expect(admin.createGiftCard).not.toHaveBeenCalled();
  });
});

describe("settleOrder — only confirmed rows count (MF-012)", () => {
  /** A row from before confirmation existed: no verifiedAt. */
  function seedLegacyRow(ref: string, state: string, filled: string) {
    db.payments.set(ref, {
      shop: SHOP,
      shopifyOrderId: ORDER,
      payramReferenceId: ref,
      state,
      filledAmountInUsd: filled,
    });
  }

  it("leaves an unconfirmed row out of the total and says so", async () => {
    seedMapping();
    seedLegacyRow("ref-old", "OVER_FILLED", "150.00");

    const out = await settle("ref-1", "PARTIALLY_FILLED" as never, "1.00");

    expect(out.receivedUsd).toBe("1.00");
    expect(out.settled).toBe(false);
    expect(admin.markOrderPaid).not.toHaveBeenCalled();
    expect(admin.createGiftCard).not.toHaveBeenCalled();
    // It was looked up — Payram could not be reached — and the merchant is told.
    expect(payram.fetchPayramPayment).toHaveBeenCalledWith(SHOP, "ref-old");
    expect(out.warnings.join(" ")).toMatch(/could not be confirmed with Payram just now/i);
  });

  it("confirms the delivered reference itself, so its row counts from now on", async () => {
    seedMapping();
    await settle("ref-1", "FILLED" as never, "54.22");

    expect(db.payments.get("ref-1")?.verifiedAt).toBeInstanceOf(Date);
  });

  it("does not take the repeat-delivery shortcut for a row nobody had confirmed", async () => {
    // A legacy row already holds exactly Payram's figures. Settling it is NOT
    // "nothing changed": it joins the total for the first time.
    seedMapping({
      paymentState: "FILLED",
      filledAmountInUsd: "0.00",
      shopifyFinancialStatus: TAG_PARTIAL,
      syncError: null,
    });
    seedLegacyRow("ref-1", "FILLED", "54.22");

    const out = await settle("ref-1", "FILLED" as never, "54.22");

    expect(out.settled).toBe(true);
    expect(admin.addOrderTags).toHaveBeenCalledWith(SHOP, "token", ORDER, [TAG_PAID]);
    expect(admin.markOrderPaid).toHaveBeenCalled();
  });

  it("acts again when the total moved without this reference changing", async () => {
    seedMapping();
    await settle("ref-1", "FILLED" as never, "54.22");
    const calls = admin.addOrderTags.mock.calls.length;

    // What settlement last acted on no longer matches the confirmed total —
    // e.g. a forged row it once counted was excluded by the upgrade.
    db.mapping = { ...db.mapping, filledAmountInUsd: "151.00" };
    await settle("ref-1", "FILLED" as never, "54.22");

    expect(admin.addOrderTags.mock.calls.length).toBe(calls + 1);
    expect(db.mapping?.filledAmountInUsd).toBe("54.22");
  });

  it("moves a row a forged webhook filed under the wrong order to its confirmed owner", async () => {
    seedMapping();
    db.payments.set("ref-1", {
      shop: SHOP,
      shopifyOrderId: "999",
      payramReferenceId: "ref-1",
      state: "OVER_FILLED",
      filledAmountInUsd: "500.00",
    });

    const out = await settle("ref-1", "FILLED" as never, "54.22");

    expect(db.payments.get("ref-1")).toMatchObject({
      shopifyOrderId: ORDER,
      filledAmountInUsd: "54.22",
    });
    expect(out.receivedUsd).toBe("54.22");
  });
});

describe("settleOrder — fill the order first, gift card only the true excess", () => {
  it("a top-up that overshoots settles the order AND refunds only the surplus", async () => {
    seedMapping(); // invoiced 54.22

    const first = await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");
    expect(first.settled).toBe(false);
    expect(admin.createGiftCard).not.toHaveBeenCalled();

    // Buyer sends 20.00 more to the same address -> new Payram reference.
    const second = await settle("ref-2", "OVER_FILLED" as never, "20.00");

    expect(second.receivedUsd).toBe("60.00");
    expect(second.settled).toBe(true);
    expect(second.giftCardIssued).toBe(true);

    // 60.00 - 54.22 = 5.78 USD surplus only, NOT the whole 20.00 top-up.
    const args = admin.createGiftCard.mock.calls[0][2] as { amount: string };
    expect(args.amount).toBe("5.33"); // 5.78 / 1.084481 EUR
  });

  it("a top-up that still falls short stays unpaid with no gift card", async () => {
    seedMapping();

    await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");
    const second = await settle("ref-2", "PARTIALLY_FILLED" as never, "5.00");

    expect(second.receivedUsd).toBe("45.00");
    expect(second.settled).toBe(false);
    expect(admin.createGiftCard).not.toHaveBeenCalled();

    const note = admin.appendOrderNote.mock.lastCall?.[4] as string;
    expect(note).toContain("9.22 USD"); // 54.22 - 45.00 still due
  });

  it("extra funds arriving after an order is already paid become a gift card", async () => {
    seedMapping();

    const paid = await settle("ref-1", "FILLED" as never, "54.22");
    expect(paid.settled).toBe(true);
    expect(admin.createGiftCard).not.toHaveBeenCalled();

    const extra = await settle("ref-2", "OVER_FILLED" as never, "10.00");

    expect(extra.settled).toBe(true);
    expect(extra.giftCardIssued).toBe(true);
    const args = admin.createGiftCard.mock.calls[0][2] as { amount: string };
    expect(args.amount).toBe("9.22"); // 10.00 USD / 1.084481
  });

  it("warns instead of silently pocketing excess that arrives after a refund", async () => {
    // A card was already issued for a 5.78 overpayment.
    seedMapping({ giftCardId: "gid://shopify/GiftCard/9", balanceUsd: "5.78" });

    // Now even more arrives: total 74.22 -> 20.00 over.
    const out = await settle("ref-2", "OVER_FILLED" as never, "74.22");

    expect(admin.createGiftCard).not.toHaveBeenCalled(); // never double-mint
    expect(out.warnings.join(" ")).toMatch(/further .* arrived/i);
    expect(out.warnings.join(" ")).toMatch(/manually/i);
  });
});

describe("effectiveTolerance — proportional, with a floor", () => {
  const D = (v: string) => new (require("@prisma/client").Prisma.Decimal)(v);

  it("uses the floor when 1% is smaller than it", () => {
    // $50 order: 1% = $0.50, floor $1.00 wins.
    expect(effectiveTolerance(D("50"), "1.0", "1.00").toFixed(2)).toBe("1.00");
  });

  it("scales with the order once 1% exceeds the floor", () => {
    // $1,000 order: 1% = $10.00.
    expect(effectiveTolerance(D("1000"), "1.0", "1.00").toFixed(2)).toBe("10.00");
  });

  it("honours a merchant's own percentage", () => {
    expect(effectiveTolerance(D("1000"), "0.5", "1.00").toFixed(2)).toBe("5.00");
  });

  it("honours a merchant's own floor", () => {
    expect(effectiveTolerance(D("50"), "1.0", "3.00").toFixed(2)).toBe("3.00");
  });

  it("falls back to the defaults on malformed config", () => {
    expect(effectiveTolerance(D("50"), "not-a-number", null).toFixed(2)).toBe("1.00");
    expect(effectiveTolerance(D("50"), null, undefined).toFixed(2)).toBe("1.00");
  });
});

describe("settleOrder — tolerance is applied to real orders", () => {
  it("accepts a shortfall inside the proportional tolerance", async () => {
    seedMapping({ amountInUsd: "1000.00" });
    // $6 short on $1,000 — inside the 1% ($10) allowance.
    const out = await settle("ref-1", "PARTIALLY_FILLED" as never, "994.00");

    expect(out.settled).toBe(true);
    expect(admin.addOrderTags).toHaveBeenCalledWith(SHOP, "token", ORDER, [
      TAG_PAID,
    ]);
  });

  it("still flags a shortfall beyond the tolerance", async () => {
    seedMapping({ amountInUsd: "1000.00" });
    const out = await settle("ref-1", "PARTIALLY_FILLED" as never, "985.00");

    expect(out.settled).toBe(false);
    expect(admin.addOrderTags).toHaveBeenCalledWith(SHOP, "token", ORDER, [
      TAG_PARTIAL,
    ]);
  });

  it("a tighter merchant setting catches what the default would absorb", async () => {
    seedMapping({ amountInUsd: "1000.00" });
    db.config = {
      ...db.config,
      settlementTolerancePercent: "0.1", // $1.00 on a $1,000 order
    };
    const out = await settle("ref-1", "PARTIALLY_FILLED" as never, "994.00");

    expect(out.settled).toBe(false);
  });
});

describe("settleOrder — repeat webhook deliveries", () => {
  it("does no Shopify work when nothing changed", async () => {
    seedMapping();

    await settle("ref-1", "FILLED" as never, "54.22");
    const callsAfterFirst = admin.addOrderTags.mock.calls.length;

    // Payram re-sends every 3 seconds during confirmation.
    await settle("ref-1", "FILLED" as never, "54.22");
    await settle("ref-1", "FILLED" as never, "54.22");

    expect(admin.addOrderTags.mock.calls.length).toBe(callsAfterFirst);
    expect(admin.fetchOrderSettlementContext.mock.calls.length).toBe(1);
  });

  it("still reports the settled state on a repeat delivery", async () => {
    seedMapping();
    await settle("ref-1", "FILLED" as never, "54.22");
    const repeat = await settle("ref-1", "FILLED" as never, "54.22");

    expect(repeat.settled).toBe(true);
    expect(repeat.balanceUsd).toBe("0.00");
  });

  it("acts again once the amount actually moves", async () => {
    seedMapping();
    await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");
    await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00"); // no-op
    const grown = await settle("ref-1", "FILLED" as never, "54.22");

    expect(grown.settled).toBe(true);
    expect(admin.addOrderTags).toHaveBeenLastCalledWith(SHOP, "token", ORDER, [
      TAG_PAID,
    ]);
  });

  it("retries when the previous attempt left a syncError", async () => {
    seedMapping();
    admin.addOrderTags.mockRejectedValueOnce(new Error("rate limited"));

    await settle("ref-1", "FILLED" as never, "54.22"); // stores syncError
    admin.addOrderTags.mockResolvedValue(undefined);
    await settle("ref-1", "FILLED" as never, "54.22"); // must retry, not skip

    expect(admin.addOrderTags.mock.calls.length).toBe(2);
  });
});

describe("settleOrder — refuses to act on an unrecognised state", () => {
  it("never tags an order paid from an UNDEFINED status", async () => {
    seedMapping();

    const out = await settle("ref-1", "UNDEFINED" as never, "99999.00");

    expect(out.settled).toBe(false);
    expect(out.giftCardIssued).toBe(false);
    expect(admin.addOrderTags).not.toHaveBeenCalled();
    expect(admin.appendOrderNote).not.toHaveBeenCalled();
    expect(admin.createGiftCard).not.toHaveBeenCalled();
  });

  it("does not record the claimed amount against the order", async () => {
    seedMapping();
    await settle("ref-1", "UNDEFINED" as never, "99999.00");

    // A later legitimate payment must not inherit the bogus figure.
    const real = await settle("ref-2", "FILLED" as never, "54.22");
    expect(real.receivedUsd).toBe("54.22");
  });
});

describe("settleOrder — review fixes", () => {
  it("never erases a recorded txHash on a delivery without payment_info", async () => {
    seedMapping();

    await settleOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      referenceId: "ref-1",
      state: "PARTIALLY_FILLED" as never,
      filledAmountInUsd: "40.00",
      txHash: "0xdeadbeef",
      accessToken: "token",
      verified: true,
    });

    // Payram re-sends every 3s and payment_info is absent on some deliveries.
    await settleOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      referenceId: "ref-1",
      state: "FILLED" as never,
      filledAmountInUsd: "54.22",
      txHash: null,
      accessToken: "token",
      verified: true,
    });

    expect(db.payments.get("ref-1")?.txHash).toBe("0xdeadbeef");
  });

  it("reports settled consistently on a repeat delivery of a tolerated shortfall", async () => {
    seedMapping();

    // 50c short on a $54.22 invoice — inside the $1.00 floor, so settled.
    const first = await settle("ref-1", "PARTIALLY_FILLED" as never, "53.72");
    expect(first.settled).toBe(true);

    // The re-delivery must not answer differently for the same order.
    const repeat = await settle("ref-1", "PARTIALLY_FILLED" as never, "53.72");
    expect(repeat.settled).toBe(true);
  });

  it("does not mint a second gift card when the slot is already claimed", async () => {
    seedMapping();
    await settle("ref-1", "OVER_FILLED" as never, "60.00");
    expect(admin.createGiftCard).toHaveBeenCalledTimes(1);

    // A concurrent/later delivery finds the claim taken.
    admin.createGiftCard.mockClear();
    await settle("ref-2", "OVER_FILLED" as never, "60.00");
    expect(admin.createGiftCard).not.toHaveBeenCalled();
  });
});

describe("settleOrder — marking the order paid in Shopify", () => {
  it("marks a fully settled order paid, not just tagged", async () => {
    seedMapping();
    await settle("ref-1", "FILLED" as never, "54.22");

    expect(admin.markOrderPaid).toHaveBeenCalledWith(SHOP, "token", ORDER);
    expect(db.mapping?.shopifyMarkedPaidAt).toBeInstanceOf(Date);
  });

  it("never marks an underpaid order paid", async () => {
    seedMapping();
    await settle("ref-1", "PARTIALLY_FILLED" as never, "40.00");

    expect(admin.markOrderPaid).not.toHaveBeenCalled();
    expect(db.mapping?.shopifyMarkedPaidAt ?? null).toBeNull();
  });

  it("marks an overpaid order paid too", async () => {
    seedMapping();
    await settle("ref-1", "OVER_FILLED" as never, "60.00");

    expect(admin.markOrderPaid).toHaveBeenCalled();
  });

  it("keeps the order settled when Shopify refuses, and says what to do", async () => {
    seedMapping();
    admin.markOrderPaid.mockResolvedValue({
      ok: false,
      financialStatus: null,
      alreadyPaid: false,
      error: "User does not have permission",
    });

    const out = await settle("ref-1", "FILLED" as never, "54.22");

    expect(out.settled).toBe(true);
    expect(admin.addOrderTags).toHaveBeenCalledWith(SHOP, "token", ORDER, [TAG_PAID]);
    expect(out.warnings.join(" ")).toMatch(/Mark as paid/i);
    expect(db.mapping?.shopifyMarkedPaidAt ?? null).toBeNull();
  });

  it("survives markOrderPaid throwing", async () => {
    seedMapping();
    admin.markOrderPaid.mockRejectedValue(new Error("network down"));

    const out = await settle("ref-1", "FILLED" as never, "54.22");

    expect(out.settled).toBe(true);
    expect(out.warnings.join(" ")).toMatch(/mark orders as paid|Mark as paid/i);
  });

  it("does not mark an order paid twice", async () => {
    seedMapping({ shopifyMarkedPaidAt: new Date() });
    await settle("ref-1", "FILLED" as never, "54.22");

    expect(admin.markOrderPaid).not.toHaveBeenCalled();
  });

  it("retries marking paid on a re-check, even though nothing changed", async () => {
    seedMapping();
    admin.markOrderPaid.mockResolvedValueOnce({
      ok: false,
      financialStatus: null,
      alreadyPaid: false,
      error: "temporary",
    });

    await settle("ref-1", "FILLED" as never, "54.22");
    expect(db.mapping?.shopifyMarkedPaidAt ?? null).toBeNull();

    // Merchant presses "Re-check payment".
    admin.markOrderPaid.mockResolvedValue({
      ok: true,
      financialStatus: "PAID",
      alreadyPaid: false,
    });
    await settleOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      referenceId: "ref-1",
      state: "FILLED" as never,
      filledAmountInUsd: "54.22",
      txHash: null,
      accessToken: "token",
      verified: true,
      force: true,
    });

    expect(db.mapping?.shopifyMarkedPaidAt).toBeInstanceOf(Date);
  });
});

describe("settleOrder — an overpayment left for a manual refund stays manual", () => {
  // Releases up to 1.2.0 told the merchant "Refund manually" and then reopened
  // the slot, so the next delivery or Re-check minted a card for money the
  // merchant had already refunded by hand (audit F3).
  const autoGiftCards = (on: boolean) => {
    db.config = { ...db.config, autoGiftCardOnOverpayment: on };
  };
  const recheck = () =>
    settleOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      referenceId: "ref-1",
      state: "OVER_FILLED" as never,
      filledAmountInUsd: "60.00",
      txHash: null,
      accessToken: "token",
      verified: true,
      force: true,
    });

  it("gift cards off: the slot closes, and switching them on later issues nothing for this order", async () => {
    seedMapping();
    autoGiftCards(false);

    const first = await settle("ref-1", "OVER_FILLED" as never, "60.00");
    expect(first.warnings.join(" ")).toMatch(/must be refunded manually/);
    expect(db.mapping?.giftCardId).toBe("manual_refund");

    autoGiftCards(true);
    const again = await recheck();

    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect(again.giftCardIssued).toBe(false);
    expect(again.warnings.join(" ")).toMatch(
      /Overpaid by 5\.78 USD\. This overpayment was left for you to refund by hand, so no gift card is issued for it automatically/,
    );
    expect(db.mapping?.giftCardId).toBe("manual_refund");
  });

  it("a refused gift card closes the slot: a later delivery or Re-check does not mint one", async () => {
    seedMapping();
    admin.createGiftCard.mockRejectedValueOnce(
      new Error("Gift card could not be created: Gift cards are not enabled"),
    );

    const first = await settle("ref-1", "OVER_FILLED" as never, "60.00");
    expect(first.warnings.join(" ")).toMatch(/could not be created.*Refund manually/);
    expect(db.mapping?.giftCardId).toBe("manual_refund");

    // The merchant refunded by hand, then gift cards were enabled in Shopify.
    await recheck();
    await settle("ref-2", "OVER_FILLED" as never, "1.00");

    expect(admin.createGiftCard).toHaveBeenCalledTimes(1);
    expect(db.mapping?.giftCardId).toBe("manual_refund");
  });

  it("says how much of the overpayment arrived after it was left for a manual refund", async () => {
    seedMapping({ giftCardId: "manual_refund", balanceUsd: "5.78" });

    const out = await settle("ref-2", "OVER_FILLED" as never, "70.00");

    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect(out.warnings.join(" ")).toMatch(/Overpaid by 15\.78 USD/);
    expect(out.warnings.join(" ")).toMatch(/10\.00 USD of it arrived after 5\.78 USD was reported/);
  });

  it("an order left for a manual refund is never reported as having a gift card", async () => {
    seedMapping({ giftCardId: "manual_refund" });
    const first = await settle("ref-1", "OVER_FILLED" as never, "60.00");
    const repeat = await settle("ref-1", "OVER_FILLED" as never, "60.00");

    expect(first.giftCardIssued).toBe(false);
    expect(repeat.giftCardIssued).toBe(false);
  });

  it("a slot holding a real card still refuses a second one and says it was refunded", async () => {
    seedMapping({ giftCardId: "gid://shopify/GiftCard/9", balanceUsd: "5.78" });
    autoGiftCards(false);

    const out = await settle("ref-1", "OVER_FILLED" as never, "60.00");

    expect(out.giftCardIssued).toBe(true);
    expect(admin.createGiftCard).not.toHaveBeenCalled();
    // Not "must be refunded manually": this one was refunded as a gift card.
    expect(out.warnings.join(" ")).not.toMatch(/refunded manually/);
    expect(db.mapping?.giftCardId).toBe("gid://shopify/GiftCard/9");
  });
});

describe("giftCardSlot", () => {
  it.each([
    [null, "open"],
    [undefined, "open"],
    ["", "open"],
    ["pending", "pending"],
    ["manual_refund", "manual_refund"],
    ["gid://shopify/GiftCard/9", "issued"],
  ])("reads %s as %s", (id, slot) => {
    expect(giftCardSlot(id as string | null | undefined)).toBe(slot);
  });
});
