/**
 * Payment-page API contract.
 *
 * `/pay/{token}` drives this endpoint from the buyer's browser and shows the
 * `error` string it returns, keyed off the HTTP status. These responses used to
 * come from Remix's `json()` helper and now come from `Response.json`; a status
 * or message that moved would change what a paying buyer sees.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { session, tokens } = vi.hoisted(() => {
  class PaymentSessionError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    session: { quoteOrder: vi.fn(), createCheckout: vi.fn(), PaymentSessionError },
    tokens: { verifyOrderToken: vi.fn() },
  };
});

vi.mock("~/utils/payment-session.server", () => session);
vi.mock("~/utils/order-token.server", () => tokens);

import { action } from "./api.payram.session";

function post(body: unknown, method = "POST") {
  return action({
    request: new Request("https://connector.example.test/api/payram/session", {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as Parameters<typeof action>[0]);
}

const claims = { shop: "acme.myshopify.com", shopifyOrderId: "1001" };

beforeEach(() => {
  vi.clearAllMocks();
  tokens.verifyOrderToken.mockReturnValue(claims);
});

describe("POST /api/payram/session", () => {
  it("refuses other methods with 405", async () => {
    const res = await post(undefined, "GET");
    expect(res.status).toBe(405);
  });

  it.each([["{not json"], ["null"], ["1"], ['"x"'], ["[]"]])(
    "answers 400 to a body that is not an object (%s)",
    async (raw) => {
      const res = await post(raw);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid request." });
    },
  );

  it("answers 403 to a token that does not verify", async () => {
    tokens.verifyOrderToken.mockReturnValue(null);
    const res = await post({ token: "forged", step: "quote" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "This payment link is not valid. Please reopen it from your order.",
    });
  });

  it("answers 400 to a malformed email before doing any work", async () => {
    const res = await post({ token: "t", step: "create", email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(session.createCheckout).not.toHaveBeenCalled();
  });

  it("returns the quote for the order the token names", async () => {
    session.quoteOrder.mockResolvedValue({ amountInUsd: "48.83" });
    const res = await post({ token: "t", step: "quote" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, quote: { amountInUsd: "48.83" } });
    expect(session.quoteOrder).toHaveBeenCalledWith(claims.shop, claims.shopifyOrderId);
  });

  it("returns the checkout link, spread into the body as before", async () => {
    session.createCheckout.mockResolvedValue({ checkoutUrl: "https://payram.example.test/c/1" });
    const res = await post({ token: "t", step: "create", email: "buyer@example.test" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      checkoutUrl: "https://payram.example.test/c/1",
    });
    expect(session.createCheckout).toHaveBeenCalledWith(
      claims.shop,
      claims.shopifyOrderId,
      "buyer@example.test",
    );
  });

  it("passes a PaymentSessionError's own status and message through", async () => {
    session.quoteOrder.mockRejectedValue(
      new session.PaymentSessionError("This order is already paid.", 409),
    );
    const res = await post({ token: "t", step: "quote" });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "This order is already paid." });
  });

  it("hides unexpected failures behind a generic 500", async () => {
    session.quoteOrder.mockRejectedValue(new Error("database is locked"));
    const res = await post({ token: "t", step: "quote" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toMatch(/database/);
  });

  it("answers 400 to an unknown step", async () => {
    const res = await post({ token: "t", step: "refund" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Unknown step." });
  });
});
