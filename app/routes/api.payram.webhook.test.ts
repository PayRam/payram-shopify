/**
 * Payram webhook HTTP contract.
 *
 * payram-core retries a webhook until it gets a 2xx, so the status code is the
 * contract: 4xx for a body that can never succeed, 200 for one that was handled
 * or deliberately ignored, 500 only when settlement itself failed and a retry
 * could help. These responses used to come from Remix's `json()` helper and now
 * come from `Response.json`; the codes and bodies must not have moved.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { prisma, settlement } = vi.hoisted(() => ({
  prisma: {
    paymentMapping: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    merchantConfig: { findUnique: vi.fn() },
    payramPayment: { upsert: vi.fn() },
  },
  settlement: { settleOrder: vi.fn() },
}));

vi.mock("~/db.server", () => ({ default: prisma }));
vi.mock("~/utils/shopify-admin.server", () => ({ findOfflineAccessToken: vi.fn() }));
vi.mock("~/utils/payram.server", () => ({
  fetchPayramPayment: vi.fn(),
  // An unsigned webhook from a shop whose Payram has never signed one: accepted
  // for confirmation, as before signatures existed (MF-013).
  authenticateWebhook: vi.fn(async () => ({
    outcome: "unauthenticated",
    signatureMismatch: false,
  })),
}));
vi.mock("~/utils/settlement.server", async (importOriginal) => ({
  // The real state normaliser: the contract depends on which statuses it knows.
  normalizePayramState: (await importOriginal<typeof import("~/utils/settlement.server")>())
    .normalizePayramState,
  settleOrder: settlement.settleOrder,
}));

import { action } from "./api.payram.webhook";

function post(body: unknown, method = "POST") {
  return action({
    request: new Request("https://connector.example.test/api/payram/webhook", {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as Parameters<typeof action>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.paymentMapping.findFirst.mockResolvedValue(null);
  prisma.paymentMapping.findUnique.mockResolvedValue(null);
});

describe("POST /api/payram/webhook", () => {
  it("refuses other methods with 405", async () => {
    const res = await post(undefined, "GET");
    expect(res.status).toBe(405);
    await expect(res.json()).resolves.toEqual({ error: "Method not allowed" });
  });

  it("answers 400 to a body that is not JSON", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("answers 400 when there is no reference to settle", async () => {
    const res = await post({ status: "FILLED" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Missing reference_id in webhook payload",
    });
  });

  it("answers 200 to a reference this connector never issued, so Payram stops retrying", async () => {
    const res = await post({ reference_id: "ref-unknown", status: "FILLED" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      note: "no matching order, ignoring",
    });
    expect(settlement.settleOrder).not.toHaveBeenCalled();
  });

  it("never settles on an unrecognised status, and still answers 200", async () => {
    prisma.paymentMapping.findFirst.mockResolvedValue({
      id: "m1",
      shop: "acme.myshopify.com",
      shopifyOrderId: "1001",
      payramReferenceId: "ref-1",
    });
    const res = await post({ reference_id: "ref-1", status: "MAYBE_PAID" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      note: "unrecognised status, ignored",
    });
    expect(settlement.settleOrder).not.toHaveBeenCalled();
    expect(prisma.paymentMapping.update).toHaveBeenCalledOnce();
  });
});
