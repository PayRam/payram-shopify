/**
 * Only amounts Payram confirms count toward an order — end to end.
 *
 * A real SQLite database built by the real migrations (`prisma migrate deploy`,
 * the command start.sh runs), the real webhook route, settlement and payment
 * page. Only the network edges are fake: Shopify's Admin API, and Payram's
 * reference lookup, served by an in-memory Payram behind a stubbed `fetch`.
 * No real Shopify store or Payram server is contacted.
 *
 * The attack this locks down (MF-012): the buyer of a $100 order posts ONE
 * forged webhook — a made-up reference plus the order's customer_id, which is
 * printed in their own payment link — claiming $150, then really pays $1. The
 * connector used to record the forged $150 "from the webhook body only", add
 * Payram's genuine $1 to it, mark the order paid and refund a $51 gift card.
 */
import { createHmac } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Build the database before anything below imports the Prisma client, so the
// client binds to it. vi.hoisted runs ahead of the imports; `require` because
// imported bindings do not exist yet at that point.
const testDb = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "payram-shopify-settlement-"));
  process.env.DATABASE_URL = `file:${join(dir, "test.sqlite")}`;
  // Test-only key; nothing real.
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  delete process.env.PAYRAM_BASE_URL;
  delete process.env.PAYRAM_PROJECT_API_KEY;
  // The same command start.sh runs, so the migrations themselves are under test.
  execSync("npx prisma migrate deploy", {
    cwd: process.cwd(),
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
  return { dir };
});

const admin = vi.hoisted(() => ({
  findOfflineAccessToken: vi.fn(),
  fetchOrderTotal: vi.fn(),
  fetchOrderSettlementContext: vi.fn(),
  addOrderTags: vi.fn(),
  appendOrderNote: vi.fn(),
  createGiftCard: vi.fn(),
  findGiftCardsByNote: vi.fn(),
  markOrderPaid: vi.fn(),
  tagShopifyOrderPaid: vi.fn(),
  // Settlement tells an unclear failure from a refusal by this class.
  GiftCardOutcomeUnknownError: class GiftCardOutcomeUnknownError extends Error {},
}));
vi.mock("~/utils/shopify-admin.server", () => admin);

// The embedded admin's session check; the settings page itself is real.
const shopifyAuth = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("~/shopify.server", () => ({ authenticate: shopifyAuth }));

const SHOP = "acme.myshopify.com";
const ORDER = "1001";
const CUSTOMER_ID = `shopify:${SHOP}:order:${ORDER}`;
const PAYRAM = "https://payram.example.test";
// Test-only value; nothing real.
const API_KEY = "test-project-api-key";

/** An in-memory Payram: the reference lookup is the only route the connector reads. */
const payram = {
  payments: new Map<string, Record<string, unknown>>(),
  down: false,
  lookups: [] as string[],
};

function payramFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const match = /^https:\/\/payram\.example\.test\/api\/v1\/payment\/reference\/([^/?]+)$/.exec(url);
  if (!match) throw new Error(`test made an unexpected request to ${url}`);
  const ref = decodeURIComponent(match[1]);
  payram.lookups.push(ref);
  if (payram.down) return Promise.reject(new TypeError("fetch failed"));
  const p = payram.payments.get(ref);
  // payram-core's PaymentRequestMiddleware answers 401 for an unknown reference.
  if (!p) return Promise.resolve(Response.json({ error: "UNAUTHORIZED" }, { status: 401 }));
  return Promise.resolve(Response.json(p));
}

/** A payment as Payram's GET /api/v1/payment/reference/:id returns it. */
function payramHas(
  ref: string,
  paymentState: string,
  filledAmountInUSD: string | null,
  customerID = CUSTOMER_ID,
) {
  payram.payments.set(ref, {
    referenceID: ref,
    customerID,
    paymentState,
    amountInUSD: "100",
    filledAmountInUSD,
  });
}

import prisma from "~/db.server";
import * as settings from "~/routes/app._index";
import * as webhook from "~/routes/api.payram.webhook";
import * as encryption from "~/utils/encryption.server";
import * as session from "~/utils/payment-session.server";
import * as settlement from "~/utils/settlement.server";

afterAll(async () => {
  await prisma.$disconnect();
  vi.unstubAllGlobals();
  rmSync(testDb.dir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(payramFetch));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  payram.payments.clear();
  payram.down = false;
  payram.lookups = [];

  admin.findOfflineAccessToken.mockResolvedValue("shpat_test");
  shopifyAuth.admin.mockResolvedValue({ session: { shop: SHOP, scope: "write_gift_cards" } });
  admin.fetchOrderTotal.mockResolvedValue({
    orderName: "#1001",
    amount: "100.00",
    currencyCode: "USD",
    fullyPaidInShopify: false,
  });
  admin.fetchOrderSettlementContext.mockResolvedValue({
    orderName: "#1001",
    note: "",
    customerId: "gid://shopify/Customer/1",
    shopCurrencyCode: "USD",
  });
  admin.addOrderTags.mockResolvedValue(undefined);
  admin.appendOrderNote.mockResolvedValue(undefined);
  admin.markOrderPaid.mockResolvedValue({ ok: true, financialStatus: "PAID", alreadyPaid: false });
  admin.createGiftCard.mockResolvedValue({
    id: "gid://shopify/GiftCard/1",
    lastCharacters: "abcd",
    amount: "0",
    currencyCode: "USD",
    notified: true,
  });

  await prisma.payramPayment.deleteMany({});
  await prisma.paymentMapping.deleteMany({});
  await prisma.merchantConfig.deleteMany({});
  await prisma.merchantConfig.create({
    data: {
      shop: SHOP,
      payramBaseUrl: PAYRAM,
      payramProjectApiKeyEncrypted: encryption.encrypt(API_KEY),
      // On, so any path that wrongly counts money would really mint a card.
      autoGiftCardOnOverpayment: true,
    },
  });
  // The buyer has opened the payment page for their $100 order.
  await prisma.paymentMapping.create({
    data: {
      shop: SHOP,
      shopifyOrderId: ORDER,
      payramReferenceId: "real-ref",
      orderCurrency: "USD",
      orderAmount: "100.00",
      amountInUsd: "100.00",
      fxRate: "1",
      fxSource: "test",
    },
  });
});

function sign(raw: string, key = API_KEY): string {
  return `sha256=${createHmac("sha256", key).update(raw).digest("hex")}`;
}

async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(body);
  const res = await webhook.action({
    request: new Request("https://connector.example.test/api/payram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: raw,
    }),
    params: {},
    context: {},
  } as Parameters<typeof webhook.action>[0]);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** What a buyer can forge: a made-up reference and their order's customer_id. */
const forged = (claim: Record<string, unknown> = {}) => ({
  reference_id: "forged-ref-not-in-payram",
  customer_id: CUSTOMER_ID,
  status: "OVER_FILLED",
  filled_amount_in_usd: "150.00",
  ...claim,
});

/** Payram's own webhook for a reference it knows. */
const genuine = (ref: string, status: string, filled: string) => ({
  reference_id: ref,
  customer_id: CUSTOMER_ID,
  status,
  filled_amount_in_usd: filled,
});

const mapping = () =>
  prisma.paymentMapping.findUniqueOrThrow({
    where: { shop_shopifyOrderId: { shop: SHOP, shopifyOrderId: ORDER } },
  });
const row = (ref: string) => prisma.payramPayment.findUnique({ where: { payramReferenceId: ref } });

/** A row written before the connector recorded confirmation (verifiedAt NULL). */
const legacyRow = (ref: string, state: string, filled: string | null, order = ORDER) =>
  prisma.payramPayment.create({
    data: { shop: SHOP, shopifyOrderId: order, payramReferenceId: ref, state, filledAmountInUsd: filled },
  });

function expectShopifyUntouched() {
  expect(admin.addOrderTags).not.toHaveBeenCalled();
  expect(admin.appendOrderNote).not.toHaveBeenCalled();
  expect(admin.markOrderPaid).not.toHaveBeenCalled();
  expect(admin.createGiftCard).not.toHaveBeenCalled();
}

describe("forged webhooks change nothing (MF-012)", () => {
  it("the two-step attack: forged $150, then a real $1 — not marked paid, no gift card, $1 received", async () => {
    const first = await post(forged());
    expect(first.status).toBe(200);
    expect(await prisma.payramPayment.count()).toBe(0);
    expectShopifyUntouched();

    payramHas("real-ref", "PARTIALLY_FILLED", "1.00");
    const second = await post(genuine("real-ref", "PARTIALLY_FILLED", "1.00"));

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ settled: false, giftCardIssued: false, balanceUsd: "-99.00" });
    expect(admin.markOrderPaid).not.toHaveBeenCalled();
    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect(admin.addOrderTags).toHaveBeenCalledWith(SHOP, "shpat_test", ORDER, [
      settlement.TAG_PARTIAL,
    ]);
    const m = await mapping();
    expect(m.filledAmountInUsd).toBe("1.00");
    expect(m.shopifyMarkedPaidAt).toBeNull();
    expect(m.giftCardId).toBeNull();
  });

  it("a forged webhook alone: no tag, note or paid status, and the payment page still shows the balance", async () => {
    const res = await post(forged({ status: "FILLED", filled_amount_in_usd: "100.00" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, note: "not confirmed by Payram, ignored" });
    expectShopifyUntouched();
    expect(await prisma.payramPayment.count()).toBe(0);
    const m = await mapping();
    expect(m.syncError).toMatch(
      /could not be confirmed with Payram and was ignored\. If the customer paid, use Re-check payment\./,
    );
    expect(m.shopifyFinancialStatus).toBeNull();

    const quote = await session.quoteOrder(SHOP, ORDER);
    expect(quote).toMatchObject({ receivedUsd: "0.00", remainingUsd: "100.00", phase: "unpaid" });
  });

  it("a forged webhook for an EXISTING real reference during a Payram outage leaves its amount alone", async () => {
    payramHas("real-ref", "PARTIALLY_FILLED", "40.00");
    await post(genuine("real-ref", "PARTIALLY_FILLED", "40.00"));
    vi.clearAllMocks();

    payram.down = true;
    const res = await post(genuine("real-ref", "OVER_FILLED", "500.00"));

    expect(res.status).toBe(503);
    expect(await row("real-ref")).toMatchObject({
      state: "PARTIALLY_FILLED",
      filledAmountInUsd: "40.00",
    });
    expectShopifyUntouched();
    expect((await mapping()).filledAmountInUsd).toBe("40.00");
  });

  it("a forged CANCELLED cannot wipe a real amount", async () => {
    payramHas("real-ref", "PARTIALLY_FILLED", "40.00");
    await post(genuine("real-ref", "PARTIALLY_FILLED", "40.00"));

    payram.down = true;
    expect((await post(genuine("real-ref", "CANCELLED", "0"))).status).toBe(503);
    payram.down = false;
    // Payram up: the message is just a trigger — Payram's figures are recorded.
    expect((await post(genuine("real-ref", "CANCELLED", "0"))).status).toBe(200);

    expect(await row("real-ref")).toMatchObject({
      state: "PARTIALLY_FILLED",
      filledAmountInUsd: "40.00",
    });
    const quote = await session.quoteOrder(SHOP, ORDER);
    expect(quote.receivedUsd).toBe("40.00");
  });

  it("Payram unreachable: 503 so Payram resends, and nothing is recorded", async () => {
    payram.down = true;
    const res = await post(genuine("real-ref", "FILLED", "100.00"));

    expect(res.status).toBe(503);
    expect(await prisma.payramPayment.count()).toBe(0);
    expectShopifyUntouched();
    const m = await mapping();
    expect(m.filledAmountInUsd).toBeNull();
    expect(m.syncError).toMatch(/could not be confirmed with Payram \(Payram could not be reached\), so nothing was changed/);

    // The same delivery, retried once Payram is back, settles the order.
    payram.down = false;
    payramHas("real-ref", "FILLED", "100.00");
    const retried = await post(genuine("real-ref", "FILLED", "100.00"));
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ settled: true });
    expect(admin.markOrderPaid).toHaveBeenCalledOnce();
    expect((await mapping()).syncError).toBeNull();
  });

  it("no Payram configured: 503, nothing recorded", async () => {
    await prisma.merchantConfig.deleteMany({});
    const res = await post(genuine("real-ref", "FILLED", "100.00"));

    expect(res.status).toBe(503);
    expect(await prisma.payramPayment.count()).toBe(0);
    expectShopifyUntouched();
  });

  it("Payram answering 5xx is no answer: 503, nothing recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    const res = await post(genuine("real-ref", "FILLED", "100.00"));

    expect(res.status).toBe(503);
    expect(await prisma.payramPayment.count()).toBe(0);
  });

  it("a reference Payram says belongs to another order is ignored with 200", async () => {
    payramHas("other-ref", "OVER_FILLED", "500.00", `shopify:${SHOP}:order:2002`);
    const res = await post(genuine("other-ref", "OVER_FILLED", "500.00"));

    expect(res.status).toBe(200);
    expect(await prisma.payramPayment.count()).toBe(0);
    expectShopifyUntouched();
    expect((await mapping()).syncError).toMatch(/belongs to a different order/);
  });

  it("settles on Payram's amount, never the body's", async () => {
    payramHas("real-ref", "PARTIALLY_FILLED", "10.00");
    const res = await post(genuine("real-ref", "OVER_FILLED", "900.00"));

    expect(res.body).toMatchObject({ settled: false, giftCardIssued: false });
    expect(await row("real-ref")).toMatchObject({ filledAmountInUsd: "10.00" });
  });

  it("repeat deliveries of a settled payment still do no Shopify work", async () => {
    payramHas("real-ref", "FILLED", "100.00");
    await post(genuine("real-ref", "FILLED", "100.00"));
    const tags = admin.addOrderTags.mock.calls.length;

    await post(genuine("real-ref", "FILLED", "100.00"));
    await post(genuine("real-ref", "FILLED", "100.00"));

    expect(admin.addOrderTags.mock.calls.length).toBe(tags);
    expect(admin.markOrderPaid).toHaveBeenCalledOnce();
  });
});

describe("rows recorded before confirmation existed", () => {
  it("do not count until confirmed, even on the payment page while Payram is down", async () => {
    await legacyRow("forged-old", "OVER_FILLED", "150.00");
    payram.down = true;

    const quote = await session.quoteOrder(SHOP, ORDER);

    expect(quote).toMatchObject({ receivedUsd: "0.00", remainingUsd: "100.00" });
    expect(quote.phase).not.toBe("paid");
  });

  it("are confirmed or rejected when the order is next settled", async () => {
    await legacyRow("honest-old", "PARTIALLY_FILLED", "40.00");
    await legacyRow("forged-old", "OVER_FILLED", "150.00");
    payramHas("honest-old", "PARTIALLY_FILLED", "40.00");
    payramHas("topup-ref", "FILLED", "60.00");

    // The buyer tops up; Payram's webhook for it arrives under a new reference.
    const res = await post(genuine("topup-ref", "FILLED", "60.00"));

    expect(res.body).toMatchObject({ settled: true, giftCardIssued: false, balanceUsd: "0.00" });
    expect(admin.markOrderPaid).toHaveBeenCalledOnce();
    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect((await row("honest-old"))?.verifiedAt).toBeInstanceOf(Date);
    const rejected = await row("forged-old");
    expect(rejected?.verifiedAt).toBeNull();
    expect(rejected?.rejectedAt).toBeInstanceOf(Date);
    // The claim is kept as the record of what was claimed.
    expect(rejected?.filledAmountInUsd).toBe("150.00");
    expect((await mapping()).syncError).toMatch(/could not be confirmed with Payram/);
  });

  it("an honest buyer's earlier payment is credited on the payment page, looked up once", async () => {
    await legacyRow("honest-old", "PARTIALLY_FILLED", "40.00");
    payramHas("honest-old", "PARTIALLY_FILLED", "40.00");

    const first = await session.quoteOrder(SHOP, ORDER);
    const second = await session.quoteOrder(SHOP, ORDER);

    expect(first).toMatchObject({ receivedUsd: "40.00", remainingUsd: "60.00", phase: "partial" });
    expect(second.remainingUsd).toBe("60.00");
    expect(payram.lookups.filter((r) => r === "honest-old")).toHaveLength(1);
  });

  it("a rejected row is excluded for good and never looked up again automatically", async () => {
    await legacyRow("forged-old", "OVER_FILLED", "150.00");

    await session.quoteOrder(SHOP, ORDER);
    await session.quoteOrder(SHOP, ORDER);
    payramHas("real-ref", "PARTIALLY_FILLED", "5.00");
    await post(genuine("real-ref", "PARTIALLY_FILLED", "5.00"));

    expect(payram.lookups.filter((r) => r === "forged-old")).toHaveLength(1);
    expect((await session.quoteOrder(SHOP, ORDER)).receivedUsd).toBe("5.00");
  });

  it("are confirmed by Re-check payment, which settles on Payram's figures only", async () => {
    await legacyRow("real-ref", "PARTIALLY_FILLED", "40.00");
    await legacyRow("topup-old", "OVER_FILLED", "60.00");
    await legacyRow("forged-old", "OVER_FILLED", "150.00");
    payramHas("real-ref", "PARTIALLY_FILLED", "40.00");
    payramHas("topup-old", "FILLED", "60.00");

    const result = await settlement.recheckOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      accessToken: "shpat_test",
      latestReferenceId: "real-ref",
    });

    expect(result.outcome).toMatchObject({ settled: true, receivedUsd: "100.00", giftCardIssued: false });
    expect(result.notConfirmed).toEqual(["forged-old"]);
    expect(admin.markOrderPaid).toHaveBeenCalledOnce();
    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect((await row("forged-old"))?.rejectedAt).toBeInstanceOf(Date);
  });

  it("Re-check looks at a rejected row again, so fixing a wrong Payram setting can undo it", async () => {
    await legacyRow("honest-old", "PARTIALLY_FILLED", "40.00");
    // Payram does not know it yet — say the Base URL pointed at the wrong server.
    await session.quoteOrder(SHOP, ORDER);
    expect((await row("honest-old"))?.rejectedAt).toBeInstanceOf(Date);

    payramHas("honest-old", "PARTIALLY_FILLED", "40.00");
    payramHas("real-ref", "OPEN", null);
    const result = await settlement.recheckOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      accessToken: "shpat_test",
      latestReferenceId: "real-ref",
    });

    expect(result.outcome?.receivedUsd).toBe("40.00");
    expect(await row("honest-old")).toMatchObject({ rejectedAt: null });
    expect((await row("honest-old"))?.verifiedAt).toBeInstanceOf(Date);
  });

  it("Re-check never credits a reference Payram assigns to another order", async () => {
    await legacyRow("theirs", "OVER_FILLED", "150.00");
    payramHas("theirs", "OVER_FILLED", "150.00", `shopify:${SHOP}:order:2002`);
    payramHas("real-ref", "PARTIALLY_FILLED", "1.00");

    const result = await settlement.recheckOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      accessToken: "shpat_test",
      latestReferenceId: "real-ref",
    });

    expect(result.outcome).toMatchObject({ settled: false, receivedUsd: "1.00" });
    expect(result.notConfirmed).toEqual(["theirs"]);
    expect(admin.markOrderPaid).not.toHaveBeenCalled();
    expect(admin.createGiftCard).not.toHaveBeenCalled();
  });

  it("Re-check with Payram unreachable changes nothing and says so", async () => {
    await legacyRow("real-ref", "FILLED", "100.00");
    payram.down = true;

    const result = await settlement.recheckOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      accessToken: "shpat_test",
      latestReferenceId: "real-ref",
    });

    expect(result.outcome).toBeNull();
    expect(result.unreachable).toEqual(["real-ref"]);
    expect(await row("real-ref")).toMatchObject({ verifiedAt: null, rejectedAt: null });
    expectShopifyUntouched();
  });
});

describe("webhook signatures (MF-013)", () => {
  const config = () => prisma.merchantConfig.findUniqueOrThrow({ where: { shop: SHOP } });

  it("unsigned webhooks are accepted — and confirmed — while this shop's Payram has never signed", async () => {
    payramHas("real-ref", "FILLED", "100.00");
    const res = await post(genuine("real-ref", "FILLED", "100.00"));

    expect(res.body).toMatchObject({ settled: true });
    expect((await config()).signedWebhooksSince).toBeNull();
  });

  it("after one correctly signed webhook, unsigned and wrongly signed ones are refused with 401 and nothing recorded", async () => {
    payramHas("real-ref", "PARTIALLY_FILLED", "40.00");
    const body = genuine("real-ref", "PARTIALLY_FILLED", "40.00");
    const signed = await post(body, { "X-Payram-Signature": sign(JSON.stringify(body)) });
    expect(signed.status).toBe(200);
    expect((await config()).signedWebhooksSince).toBeInstanceOf(Date);

    vi.clearAllMocks();
    payram.lookups = [];
    const before = await mapping();

    const unsigned = await post(forged());
    const forgedBody = forged();
    const wrong = await post(forgedBody, {
      "X-Payram-Signature": sign(JSON.stringify(forgedBody), "not-the-key"),
    });

    expect(unsigned.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(String(wrong.body.error)).toMatch(/does not match the Payram API key/);
    // Refused before anything was read from Payram or written anywhere.
    expect(payram.lookups).toEqual([]);
    expectShopifyUntouched();
    const after = await mapping();
    expect(after.syncError).toBe(before.syncError);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await prisma.payramPayment.count()).toBe(1);
  });

  it("a wrong signature before the shop has proven it signs is still only accepted through Payram", async () => {
    const body = forged();
    const res = await post(body, { "X-Payram-Signature": sign(JSON.stringify(body), "old-key") });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, note: "not confirmed by Payram, ignored" });
    expect(await prisma.payramPayment.count()).toBe(0);
    expect((await config()).signedWebhooksSince).toBeNull();
    expectShopifyUntouched();
  });

  it("a signed webhook still needs Payram's confirmation", async () => {
    const body = forged();
    const res = await post(body, { "X-Payram-Signature": sign(JSON.stringify(body)) });

    expect(res.status).toBe(200);
    expect(await prisma.payramPayment.count()).toBe(0);
    expectShopifyUntouched();
  });
});

describe("overpayments the merchant was told to refund by hand (audit F3)", () => {
  // What releases up to 1.2.0 wrote when the gift card could not be created.
  // On 1.1.0 that was every order with a customer: the invalid recipient field
  // made Shopify reject the request, which read as an unclear failure.
  const refundManuallyBy110 =
    "Overpaid by 50.00 USD but the gift card could not be created: Gift card could not be " +
    "created and it is unclear whether Shopify created one (Shopify rejected the create gift " +
    "card request. If this persists, the merchant should reopen the Payram app in Shopify " +
    "Admin to refresh its permissions.). Check Shopify Admin → Gift cards before refunding " +
    "manually.. Refund manually.";

  /** The upgrade: the migration that turns those words into a closed slot. */
  async function upgrade() {
    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20261026120000_manual_refund_gift_card_slot/migration.sql",
      ),
      "utf8",
    );
    await prisma.$executeRawUnsafe(sql);
  }

  /** The end state 1.1.0 left: paid in Shopify, $50 over, no card, told to refund by hand. */
  async function settledBy110(syncError: string, order = ORDER) {
    await prisma.paymentMapping.upsert({
      where: { shop_shopifyOrderId: { shop: SHOP, shopifyOrderId: order } },
      create: {
        shop: SHOP,
        shopifyOrderId: order,
        payramReferenceId: order === ORDER ? "real-ref" : `ref-${order}`,
        amountInUsd: "100.00",
        orderCurrency: "USD",
        fxRate: "1",
      },
      update: {},
    });
    await prisma.paymentMapping.update({
      where: { shop_shopifyOrderId: { shop: SHOP, shopifyOrderId: order } },
      data: {
        paymentState: "OVER_FILLED",
        filledAmountInUsd: "150.00",
        balanceUsd: "50.00",
        shopifyFinancialStatus: "payram_paid",
        shopifyMarkedPaidAt: new Date("2026-10-20T10:00:00Z"),
        giftCardId: null,
        syncError,
      },
    });
  }

  const recheck = () =>
    settlement.recheckOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      accessToken: "shpat_test",
      latestReferenceId: "real-ref",
    });

  it("an order 1.1.0 told to refund by hand gets no gift card on Re-check after the upgrade", async () => {
    await settledBy110(refundManuallyBy110);
    // 1.1.0 recorded the payment before confirmation existed.
    await legacyRow("real-ref", "OVER_FILLED", "150.00");
    payramHas("real-ref", "OVER_FILLED", "150.00");

    await upgrade();
    const result = await recheck();

    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect(result.outcome).toMatchObject({ settled: true, giftCardIssued: false, balanceUsd: "50.00" });
    const m = await mapping();
    expect(m.giftCardId).toBe("manual_refund");
    // The merchant still sees that it needs a manual refund.
    expect(m.syncError).toMatch(
      /Overpaid by 50\.00 USD\. This overpayment was left for you to refund by hand/,
    );
  });

  it("so does one 1.1.0 left with gift cards off, after the merchant switches them on", async () => {
    await settledBy110(
      "Overpaid by 50.00 USD. Automatic gift cards are off, so this must be refunded manually. " +
        "Enable it in the Payram app settings to automate it.",
    );
    payramHas("real-ref", "OVER_FILLED", "150.00");

    await upgrade();
    // beforeEach leaves gift cards switched on.
    await recheck();

    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect((await mapping()).giftCardId).toBe("manual_refund");
  });

  it("so does one 1.1.0 could not verify, once Payram confirms it", async () => {
    await settledBy110(
      "Overpaid by 50.00 USD, but the payment could not be verified with Payram, so no gift " +
        "card was issued. Confirm the payment in Payram and refund manually.",
    );
    await legacyRow("real-ref", "OVER_FILLED", "150.00");
    payramHas("real-ref", "OVER_FILLED", "150.00");

    await upgrade();
    await post(genuine("real-ref", "OVER_FILLED", "150.00"));

    expect(admin.createGiftCard).not.toHaveBeenCalled();
    expect((await mapping()).giftCardId).toBe("manual_refund");
  });

  it("the upgrade leaves every other order alone", async () => {
    await settledBy110(
      "Overpaid by 0.50 USD, which is below the 1.00 USD gift card minimum. No gift card was issued.",
    );
    await settledBy110(refundManuallyBy110, "2002");
    await prisma.paymentMapping.update({
      where: { shop_shopifyOrderId: { shop: SHOP, shopifyOrderId: "2002" } },
      data: { giftCardId: "gid://shopify/GiftCard/7" },
    });

    await upgrade();
    await upgrade(); // and running it twice changes nothing

    expect((await mapping()).giftCardId).toBeNull();
    const other = await prisma.paymentMapping.findUniqueOrThrow({
      where: { shop_shopifyOrderId: { shop: SHOP, shopifyOrderId: "2002" } },
    });
    expect(other.giftCardId).toBe("gid://shopify/GiftCard/7");
  });

  it("a gift card Shopify refuses now is not issued by a later Re-check either", async () => {
    payramHas("real-ref", "OVER_FILLED", "150.00");
    admin.createGiftCard.mockRejectedValueOnce(
      new Error("Gift card could not be created: Gift cards are not enabled for this shop"),
    );

    const first = await post(genuine("real-ref", "OVER_FILLED", "150.00"));
    expect(first.body).toMatchObject({ settled: true, giftCardIssued: false });
    expect((await mapping()).syncError).toMatch(/could not be created.*Refund manually/);

    // The merchant refunds by hand, enables gift cards, then presses Re-check.
    const again = await recheck();

    expect(admin.createGiftCard).toHaveBeenCalledOnce();
    expect(again.outcome?.giftCardIssued).toBe(false);
    expect((await mapping()).giftCardId).toBe("manual_refund");
  });
});

describe("a gift card Shopify may have made (audit F4)", () => {
  const unclear = () =>
    new admin.GiftCardOutcomeUnknownError(
      "Gift card could not be created and it is unclear whether Shopify created one " +
        "(Could not reach Shopify (create gift card). Please try again shortly.).",
    );
  const recheck = () =>
    settlement.recheckOrder({
      shop: SHOP,
      shopifyOrderId: ORDER,
      accessToken: "shpat_test",
      latestReferenceId: "real-ref",
    });
  /** Ten minutes and more pass after the unclear attempt. */
  async function waitOutShopify() {
    const m = await mapping();
    const since = new Date(String(m.giftCardId).slice("unconfirmed:".length));
    await prisma.paymentMapping.update({
      where: { id: m.id },
      data: { giftCardId: `unconfirmed:${new Date(since.getTime() - 11 * 60_000).toISOString()}` },
    });
  }

  it("a timeout after Shopify made the card: Re-check finds and records it, and mints no second card", async () => {
    payramHas("real-ref", "OVER_FILLED", "150.00");
    admin.createGiftCard.mockRejectedValueOnce(unclear());

    const first = await post(genuine("real-ref", "OVER_FILLED", "150.00"));
    expect(first.body).toMatchObject({ settled: true, giftCardIssued: false });
    let m = await mapping();
    expect(m.giftCardId).toMatch(/^unconfirmed:/);
    // Needs review: listed with what to check and not to refund by hand.
    expect(m.syncError).toMatch(/Shopify may have made it.*Do not refund it by hand as well/);

    // Pressed straight away (the audit's probe P5): nothing is created.
    const early = await recheck();
    expect(admin.createGiftCard).toHaveBeenCalledOnce();
    expect(admin.findGiftCardsByNote).not.toHaveBeenCalled();
    expect(early.outcome?.giftCardIssued).toBe(false);

    // Later: Shopify lists the card the timed-out request made.
    await waitOutShopify();
    admin.findGiftCardsByNote.mockResolvedValue([
      { id: "gid://shopify/GiftCard/55", lastCharacters: "w8w8", amount: "50.00", currencyCode: "USD" },
    ]);
    const later = await recheck();

    expect(admin.createGiftCard).toHaveBeenCalledOnce();
    expect(later.outcome?.giftCardIssued).toBe(true);
    m = await mapping();
    expect(m).toMatchObject({
      giftCardId: "gid://shopify/GiftCard/55",
      giftCardLastChars: "w8w8",
      giftCardAmount: "50.00",
    });
    expect(admin.findGiftCardsByNote.mock.calls[0][2]).toMatchObject({
      noteIncludes: `[Payram order ${ORDER}]`,
    });

    // And from then on the order has its card: no more lookups, no more cards.
    await recheck();
    await post(genuine("real-ref", "OVER_FILLED", "150.00"));
    expect(admin.createGiftCard).toHaveBeenCalledOnce();
    expect(admin.findGiftCardsByNote).toHaveBeenCalledOnce();
  });

  it("a timeout before Shopify made anything: issued once Shopify confirms there is no card", async () => {
    payramHas("real-ref", "OVER_FILLED", "150.00");
    admin.createGiftCard.mockRejectedValueOnce(unclear());
    await post(genuine("real-ref", "OVER_FILLED", "150.00"));

    await waitOutShopify();
    admin.findGiftCardsByNote.mockResolvedValue([]);
    const result = await recheck();

    expect(admin.createGiftCard).toHaveBeenCalledTimes(2);
    expect(result.outcome?.giftCardIssued).toBe(true);
    expect((await mapping()).giftCardId).toBe("gid://shopify/GiftCard/1");
  });

  it("repeat deliveries while it is unclear create nothing", async () => {
    payramHas("real-ref", "OVER_FILLED", "150.00");
    admin.createGiftCard.mockRejectedValueOnce(unclear());
    for (let i = 0; i < 4; i += 1) {
      await post(genuine("real-ref", "OVER_FILLED", "150.00"));
    }
    expect(admin.createGiftCard).toHaveBeenCalledOnce();
    expect((await mapping()).giftCardId).toMatch(/^unconfirmed:/);
  });

  it("a refusal Shopify states plainly still closes the slot for a manual refund", async () => {
    payramHas("real-ref", "OVER_FILLED", "150.00");
    admin.createGiftCard.mockRejectedValueOnce(
      new Error("Gift card could not be created: Gift cards are not enabled for this shop"),
    );
    await post(genuine("real-ref", "OVER_FILLED", "150.00"));

    await recheck();

    expect(admin.createGiftCard).toHaveBeenCalledOnce();
    expect(admin.findGiftCardsByNote).not.toHaveBeenCalled();
    expect((await mapping()).giftCardId).toBe("manual_refund");
  });
});

describe("webhooks refused after a newer API key appears in Payram (audit F2)", () => {
  // payram-core signs with the project's NEWEST admin key. Once a shop is
  // enforcing signatures, a key created later for anything else made every
  // payment webhook fail 401 with nothing in the app, until Payram gave up.
  const NEWER_KEY = "newer-project-api-key";
  const config = () => prisma.merchantConfig.findUniqueOrThrow({ where: { shop: SHOP } });
  const signedPost = (body: Record<string, unknown>, key = API_KEY) =>
    post(body, { "X-Payram-Signature": sign(JSON.stringify(body), key) });

  /** The shop's first signed webhook, with the saved key, pins it. */
  async function pin() {
    payramHas("real-ref", "OPEN", null);
    const res = await signedPost(genuine("real-ref", "OPEN", "0"));
    expect(res.status).toBe(200);
    expect((await config()).signedWebhooksSince).toBeInstanceOf(Date);
    vi.clearAllMocks();
    payram.lookups = [];
  }

  function settingsRequest(fields: Record<string, string>) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return new Request("https://connector.example.test/app", { method: "POST", body: form });
  }
  const loadSettings = async () =>
    (await settings.loader({
      request: new Request("https://connector.example.test/app"),
      params: {},
      context: {},
    } as Parameters<typeof settings.loader>[0])) as { webhooksRefusedAt: string | null };
  const save = (fields: Record<string, string>) =>
    settings.action({
      request: settingsRequest({ intent: "save", payramBaseUrl: PAYRAM, ...fields }),
      params: {},
      context: {},
    } as Parameters<typeof settings.action>[0]);

  it("is refused with 401, records no payment, and tells the merchant to save the current key", async () => {
    await pin();
    const before = await mapping();
    payramHas("real-ref", "FILLED", "100.00");

    const res = await signedPost(genuine("real-ref", "FILLED", "100.00"), NEWER_KEY);

    expect(res.status).toBe(401);
    // Nothing an attacker could use: no lookup, no payment row, no order change.
    expect(payram.lookups).toEqual([]);
    expectShopifyUntouched();
    expect(await row("real-ref")).toMatchObject({ state: "OPEN", filledAmountInUsd: null });
    const after = await mapping();
    expect(after.syncError).toBe(before.syncError);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // What changed: the shop records the refusal, and the settings page says so.
    const refusedAt = (await config()).signedWebhookRefusedAt;
    expect(refusedAt).toBeInstanceOf(Date);
    expect((await loadSettings()).webhooksRefusedAt).toBe(settlement.formatUtc(refusedAt!));
    // Until now the buyer's page shows the order unpaid; Re-check repairs it.
    expect((await session.quoteOrder(SHOP, ORDER)).phase).toBe("unpaid");
  });

  it("a flood of refused webhooks is one write a minute", async () => {
    await pin();
    await signedPost(genuine("real-ref", "FILLED", "100.00"), NEWER_KEY);
    const first = (await config()).signedWebhookRefusedAt;

    for (let i = 0; i < 5; i += 1) {
      expect((await signedPost(forged(), NEWER_KEY)).status).toBe(401);
    }

    expect((await config()).signedWebhookRefusedAt?.getTime()).toBe(first?.getTime());
  });

  it("an unsigned webhook to an enforcing shop is refused without raising the warning", async () => {
    await pin();
    expect((await post(forged())).status).toBe(401);
    expect((await config()).signedWebhookRefusedAt).toBeNull();
  });

  it("before the shop is enforcing, a webhook signed with another key raises nothing", async () => {
    const res = await signedPost(forged(), NEWER_KEY);
    expect(res.status).toBe(200);
    expect((await config()).signedWebhookRefusedAt).toBeNull();
  });

  it("saving the project's current key clears the warning, and its webhooks then settle", async () => {
    await pin();
    await signedPost(genuine("real-ref", "FILLED", "100.00"), NEWER_KEY);
    expect((await config()).signedWebhookRefusedAt).toBeInstanceOf(Date);

    const saved = await save({ payramProjectApiKey: NEWER_KEY });
    expect(saved).toMatchObject({ success: expect.stringMatching(/Settings saved/) });
    expect(await config()).toMatchObject({ signedWebhooksSince: null, signedWebhookRefusedAt: null });
    expect((await loadSettings()).webhooksRefusedAt).toBeNull();

    // Payram resends; signed with the key now saved, it settles and re-pins.
    payramHas("real-ref", "FILLED", "100.00");
    const resent = await signedPost(genuine("real-ref", "FILLED", "100.00"), NEWER_KEY);
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ settled: true });
    expect((await config()).signedWebhooksSince).toBeInstanceOf(Date);
  });

  it("re-saving the same key keeps the warning: nothing was fixed", async () => {
    await pin();
    await signedPost(forged(), NEWER_KEY);

    await save({ payramProjectApiKey: API_KEY });

    expect((await config()).signedWebhookRefusedAt).toBeInstanceOf(Date);
    expect((await loadSettings()).webhooksRefusedAt).not.toBeNull();
  });

  it("the next correctly signed webhook clears the warning", async () => {
    await pin();
    await signedPost(forged(), NEWER_KEY);
    expect((await config()).signedWebhookRefusedAt).toBeInstanceOf(Date);

    // The newer key was revoked in Payram, so it signs with the saved one again.
    payramHas("real-ref", "FILLED", "100.00");
    const res = await signedPost(genuine("real-ref", "FILLED", "100.00"));

    expect(res.status).toBe(200);
    expect((await config()).signedWebhookRefusedAt).toBeNull();
  });
});
