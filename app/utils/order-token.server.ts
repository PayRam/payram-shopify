/**
 * Signed order tokens for the durable payment page.
 *
 * `/pay/{token}` is the one URL a buyer needs: it is the first payment, the live
 * status, the top-up retry and the paid confirmation. It has to work for guests,
 * survive being bookmarked, and be safe to sit in browser history — so the order
 * identity travels as a signed token rather than a bare, sequential order ID.
 *
 * SCOPE OF THE PROTECTION — read this before relying on it.
 * The token means a `/pay` URL cannot be forged or edited to point at another
 * order. It does NOT by itself make orders unenumerable: tokens are issued by
 * `/api/payram/redirect-to-payment`, which still accepts a guessable
 * `shopifyOrderId`. Closing that requires a credential only the buyer holds
 * (see state/malicious-flows.md, MF-003). What the token does buy is that the
 * durable link itself is tamper-proof and scoped to exactly one order.
 */
import { createHmac, timingSafeEqual } from "crypto";

/** Bumped if the payload shape ever changes, so old links fail closed. */
const TOKEN_VERSION = "1";

/** Truncated HMAC: 24 bytes (192 bits) is far beyond forgeable. */
const SIG_BYTES = 24;

function tokenSecret(): string {
  const secret =
    process.env.PAYMENT_LINK_SECRET || process.env.SHOPIFY_API_SECRET || "";
  if (!secret) {
    throw new Error(
      "Cannot sign payment links: set PAYMENT_LINK_SECRET (or SHOPIFY_API_SECRET) " +
        "in the app environment.",
    );
  }
  return secret;
}

function b64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
  return b64url(
    createHmac("sha256", tokenSecret()).update(payload).digest().subarray(0, SIG_BYTES),
  );
}

export interface OrderTokenClaims {
  shop: string;
  shopifyOrderId: string;
}

/** Build the token that identifies an order on the payment page. */
export function signOrderToken(claims: OrderTokenClaims): string {
  const { shop, shopifyOrderId } = claims;
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    throw new Error(`Refusing to sign a token for invalid shop "${shop}".`);
  }
  if (!/^\d+$/.test(shopifyOrderId) || shopifyOrderId === "0") {
    throw new Error(
      `Refusing to sign a token for invalid order "${shopifyOrderId}".`,
    );
  }
  const payload = b64url(
    Buffer.from(`${TOKEN_VERSION}:${shop}:${shopifyOrderId}`, "utf8"),
  );
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a token and return what it claims.
 *
 * Returns null for anything that does not verify — no distinction between
 * "malformed", "wrong signature" and "old version", so nothing is leaked about
 * why a token failed.
 */
export function verifyOrderToken(token: string): OrderTokenClaims | null {
  if (typeof token !== "string" || token.length > 512) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }

  const a = fromB64url(signature);
  const b = fromB64url(expected);
  if (a.length !== b.length || a.length === 0) return null;
  if (!timingSafeEqual(a, b)) return null;

  let decoded: string;
  try {
    decoded = fromB64url(payload).toString("utf8");
  } catch {
    return null;
  }

  const parts = decoded.split(":");
  if (parts.length !== 3) return null;
  const [version, shop, shopifyOrderId] = parts;
  if (version !== TOKEN_VERSION) return null;
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return null;
  if (!/^\d+$/.test(shopifyOrderId) || shopifyOrderId === "0") return null;

  return { shop, shopifyOrderId };
}
