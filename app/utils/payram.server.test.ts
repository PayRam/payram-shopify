/**
 * Payram client: telling "Payram said no" from "Payram did not answer", and
 * checking webhook signatures exactly as payram-core makes them.
 *
 * The distinction decides the webhook's reply — 200 (final, Payram stops) or
 * 503 (Payram resends) — so calling an outage "not found" would silently drop
 * a real payment's webhook. Never contacts a real Payram: `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  updateMany: vi.fn(async () => ({ count: 1 })),
}));
vi.mock("~/db.server", () => ({
  default: {
    merchantConfig: {
      findUnique: async () => db.config,
      updateMany: db.updateMany,
    },
  },
}));
vi.mock("~/utils/encryption.server", () => ({
  // The stored "ciphertext" is the key itself in these tests.
  decrypt: (v: string) => v,
}));

import { authenticateWebhook, fetchPayramPayment, isPayramSignatureValid } from "./payram.server";

const SHOP = "acme.myshopify.com";
const KEY = "test-project-api-key";
const BODY = '{"reference_id":"ref-1","status":"FILLED"}';
// printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$KEY" — computed outside
// this code, the way payram-core's signWebhook does (HMAC-SHA256, hex).
const OPENSSL_HMAC = "f06271eb02cfc3ef9370d509208477b489017e4dd9ae7c152e64f40920aed2ab";
const bytes = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  db.config = {
    shop: SHOP,
    payramBaseUrl: "https://payram.example.test/",
    payramProjectApiKeyEncrypted: KEY,
    signedWebhooksSince: null,
  };
  db.updateMany.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isPayramSignatureValid", () => {
  it("accepts payram-core's format: sha256=<hex HMAC-SHA256 of the raw body>", () => {
    expect(isPayramSignatureValid(bytes(BODY), `sha256=${OPENSSL_HMAC}`, KEY)).toBe(true);
    expect(isPayramSignatureValid(bytes(BODY), `sha256=${OPENSSL_HMAC.toUpperCase()}`, KEY)).toBe(true);
  });

  it.each([
    ["another key", `sha256=${OPENSSL_HMAC}`, "other-key", BODY],
    ["a changed body", `sha256=${OPENSSL_HMAC}`, KEY, BODY.replace("FILLED", "OVER_FILLED")],
    ["no sha256= prefix", OPENSSL_HMAC, KEY, BODY],
    ["a truncated digest", `sha256=${OPENSSL_HMAC.slice(0, 62)}`, KEY, BODY],
    ["non-hex", `sha256=${"z".repeat(64)}`, KEY, BODY],
  ])("rejects %s", (_label, header, key, body) => {
    expect(isPayramSignatureValid(bytes(body), header, key)).toBe(false);
  });
});

describe("fetchPayramPayment — an answer vs no answer", () => {
  const stub = (impl: () => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(impl));

  it("reads Payram's figures and owner", async () => {
    stub(async () =>
      Response.json({
        customerID: `shopify:${SHOP}:order:1001`,
        paymentState: "FILLED",
        filledAmountInUSD: "54.22",
        amountInUSD: "54.22",
      }),
    );
    await expect(fetchPayramPayment(SHOP, "ref-1")).resolves.toEqual({
      status: "found",
      payment: {
        customerId: `shopify:${SHOP}:order:1001`,
        paymentState: "FILLED",
        filledAmountInUsd: "54.22",
        amountInUsd: "54.22",
      },
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "https://payram.example.test/api/v1/payment/reference/ref-1",
    );
  });

  it.each([401, 404, 410])("HTTP %i is Payram saying it has no such payment", async (code) => {
    stub(async () => new Response("{}", { status: code }));
    await expect(fetchPayramPayment(SHOP, "ref-1")).resolves.toEqual({
      status: "not_found",
      httpStatus: code,
    });
  });

  it.each([403, 429, 500, 502, 503])("HTTP %i is no answer", async (code) => {
    stub(async () => new Response("", { status: code }));
    await expect(fetchPayramPayment(SHOP, "ref-1")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("a network failure is no answer", async () => {
    stub(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchPayramPayment(SHOP, "ref-1")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("an unreadable body is no answer", async () => {
    stub(async () => new Response("<html>", { status: 200 }));
    await expect(fetchPayramPayment(SHOP, "ref-1")).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("no configuration is no answer, and nothing is fetched", async () => {
    db.config = null;
    stub(async () => Response.json({}));
    await expect(fetchPayramPayment(SHOP, "ref-1")).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("authenticateWebhook", () => {
  const headers = (sig?: string) =>
    new Headers(sig ? { "X-Payram-Signature": sig } : {});

  it("records the first correctly signed webhook, so unsigned ones are refused from then on", async () => {
    const res = await authenticateWebhook(SHOP, bytes(BODY), headers(`sha256=${OPENSSL_HMAC}`));
    expect(res).toEqual({ outcome: "signed" });
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP, signedWebhooksSince: null },
      data: { signedWebhooksSince: expect.any(Date) },
    });
  });

  it("accepts an unsigned webhook, unauthenticated, while the shop has never received a signed one", async () => {
    await expect(authenticateWebhook(SHOP, bytes(BODY), headers())).resolves.toEqual({
      outcome: "unauthenticated",
      signatureMismatch: false,
    });
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it("does not refuse a wrong signature before the shop has proven it signs (an older key of the project)", async () => {
    await expect(
      authenticateWebhook(SHOP, bytes(BODY), headers(`sha256=${"0".repeat(64)}`)),
    ).resolves.toEqual({ outcome: "unauthenticated", signatureMismatch: true });
  });

  it.each([
    ["unsigned", undefined, /not signed/],
    ["wrongly signed", `sha256=${"0".repeat(64)}`, /does not match the Payram API key/],
  ])("refuses an %s webhook once the shop's Payram signs", async (_label, sig, message) => {
    db.config = { ...db.config, signedWebhooksSince: new Date("2026-10-01") };
    const res = await authenticateWebhook(SHOP, bytes(BODY), headers(sig));
    expect(res.outcome).toBe("refused");
    expect(res.outcome === "refused" && res.message).toMatch(message);
  });

  it("still accepts a correctly signed webhook once pinned, without writing again", async () => {
    db.config = { ...db.config, signedWebhooksSince: new Date("2026-10-01") };
    await expect(
      authenticateWebhook(SHOP, bytes(BODY), headers(`sha256=${OPENSSL_HMAC}`)),
    ).resolves.toEqual({ outcome: "signed" });
    expect(db.updateMany).not.toHaveBeenCalled();
  });
});
