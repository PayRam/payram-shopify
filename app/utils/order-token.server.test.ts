/**
 * Order token tests.
 *
 * The token is what makes `/pay/{token}` safe to bookmark and safe to sit in
 * browser history: it must be impossible to edit one order's link into another
 * order's link. Everything here is about that property.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { signOrderToken, verifyOrderToken } from "./order-token.server";

const SHOP = "demo.myshopify.com";
const OTHER_SHOP = "rival.myshopify.com";

beforeEach(() => {
  vi.stubEnv("PAYMENT_LINK_SECRET", "test-secret-value-for-signing-tokens");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("round trip", () => {
  it("verifies a token it just signed", () => {
    const token = signOrderToken({ shop: SHOP, shopifyOrderId: "1001" });

    expect(verifyOrderToken(token)).toEqual({
      shop: SHOP,
      shopifyOrderId: "1001",
    });
  });

  it("produces different tokens for different orders", () => {
    const a = signOrderToken({ shop: SHOP, shopifyOrderId: "1001" });
    const b = signOrderToken({ shop: SHOP, shopifyOrderId: "1002" });
    expect(a).not.toBe(b);
  });

  it("is URL-safe", () => {
    const token = signOrderToken({ shop: SHOP, shopifyOrderId: "1001" });
    expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });
});

describe("tampering", () => {
  it("rejects a token whose payload was edited to another order", () => {
    const token = signOrderToken({ shop: SHOP, shopifyOrderId: "1001" });

    // Re-encode the payload for a different order, keep the original signature.
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const forgedPayload = Buffer.from(`1:${SHOP}:1002`, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(verifyOrderToken(`${forgedPayload}.${sig}`)).toBeNull();
  });

  it("rejects a token repointed at another shop", () => {
    const token = signOrderToken({ shop: SHOP, shopifyOrderId: "1001" });
    const sig = token.slice(token.lastIndexOf(".") + 1);
    const forged = Buffer.from(`1:${OTHER_SHOP}:1001`, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(verifyOrderToken(`${forged}.${sig}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signOrderToken({ shop: SHOP, shopifyOrderId: "1001" });

    vi.stubEnv("PAYMENT_LINK_SECRET", "a-completely-different-secret");

    expect(verifyOrderToken(token)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["no separator", "abcdef"],
    ["signature only", ".abcdef"],
    ["payload only", "abcdef."],
    ["garbage", "!!!not-a-token!!!"],
    ["absurdly long", "a".repeat(600)],
  ])("rejects a malformed token (%s)", (_label, bad) => {
    expect(verifyOrderToken(bad)).toBeNull();
  });

  it("rejects a truncated signature", () => {
    const token = signOrderToken({ shop: SHOP, shopifyOrderId: "1001" });
    expect(verifyOrderToken(token.slice(0, -4))).toBeNull();
  });
});

describe("refuses to sign nonsense", () => {
  it.each(["", "not-a-shop", "evil.com", "shop.myshopify.com.evil.com"])(
    "rejects shop %s",
    (shop) => {
      expect(() => signOrderToken({ shop, shopifyOrderId: "1" })).toThrow();
    },
  );

  it.each(["", "0", "abc", "-1", "1.5"])(
    "rejects order id %s",
    (id) => {
      expect(() => signOrderToken({ shop: SHOP, shopifyOrderId: id })).toThrow();
    },
  );
});

describe("configuration", () => {
  it("refuses to sign when no secret is configured", () => {
    vi.stubEnv("PAYMENT_LINK_SECRET", "");
    vi.stubEnv("SHOPIFY_API_SECRET", "");

    expect(() => signOrderToken({ shop: SHOP, shopifyOrderId: "1" })).toThrow(
      /PAYMENT_LINK_SECRET/,
    );
  });

  it("falls back to SHOPIFY_API_SECRET", () => {
    vi.stubEnv("PAYMENT_LINK_SECRET", "");
    vi.stubEnv("SHOPIFY_API_SECRET", "shopify-secret-fallback-value");

    const token = signOrderToken({ shop: SHOP, shopifyOrderId: "42" });
    expect(verifyOrderToken(token)?.shopifyOrderId).toBe("42");
  });
});
