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

import {
  effectiveTolerance,
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
  admin.fetchOrderSettlementContext.mockResolvedValue({
    orderName: "#1001",
    note: null,
    customerId: "gid://shopify/Customer/5",
    shopCurrencyCode: "EUR",
  });
  admin.addOrderTags.mockResolvedValue(undefined);
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
  it("refuses to issue a gift card when Payram could not confirm the payment", async () => {
    seedMapping();

    const out = await settle("ref-1", "OVER_FILLED" as never, "60.00", false);

    expect(out.settled).toBe(true);
    expect(out.giftCardIssued).toBe(false);
    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect(out.warnings.join(" ")).toMatch(/could not be verified/i);
  });

  it("still records and tags an unverified payment", async () => {
    seedMapping();

    const out = await settle("ref-1", "FILLED" as never, "54.22", false);

    expect(out.settled).toBe(true);
    expect(admin.addOrderTags).toHaveBeenCalledWith(SHOP, "token", ORDER, [
      TAG_PAID,
    ]);
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
