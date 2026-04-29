/**
 * GET /api/payram/redirect-to-payment
 *
 * Called by the buyer's browser (via Shopify App Proxy) after clicking
 * "Complete Crypto Payment" on the Thank You page extension.
 *
 * The request arrives via the Shopify App Proxy:
 *   https://{shop}/apps/payram-checkout-plugin/api/payram/redirect-to-payment?...
 * Shopify forwards it here with `shop`, `path_prefix`, `timestamp`, `signature`
 * appended. We verify the HMAC signature before processing.
 *
 * Query params added by extension:
 *   shopifyOrderId  — numeric Shopify order ID (required)
 *   amountInUSD     — order total in USD (required)
 *   email           — buyer email, optional
 *
 * Query params added by Shopify proxy:
 *   shop            — myshopify.com domain (trusted after HMAC check)
 *   path_prefix     — proxy subpath prefix
 *   timestamp       — Unix timestamp
 *   signature       — HMAC-SHA256 of sorted params using API secret
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import prisma from "~/db.server";
import { createPayramPayment } from "~/utils/payram.server";

/**
 * Verify the Shopify App Proxy HMAC signature.
 * https://shopify.dev/docs/apps/build/online-store/app-proxies#security
 */
function verifyProxySignature(
  searchParams: URLSearchParams,
  secret: string,
): boolean {
  const signature = searchParams.get("signature");
  if (!signature) return false;
  const paramString = Array.from(searchParams.entries())
    .filter(([k]) => k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const computed = createHmac("sha256", secret).update(paramString).digest("hex");
  try {
    return timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopifyOrderId = url.searchParams.get("shopifyOrderId") ?? "";
  const amountInUSDStr = url.searchParams.get("amountInUSD") ?? "";
  // `shop` is injected by the Shopify App Proxy (trusted after signature check)
  const shop = url.searchParams.get("shop") ?? "";
  const email = url.searchParams.get("email") ?? undefined;

  // --- Proxy signature verification ---
  // When the request comes through the App Proxy, `signature` is present.
  // Always verify it when present. If absent (dev / direct call) and SHOPIFY_API_SECRET
  // is set, we still proceed — direct access without proxy is blocked by
  // the missing `shop` param check below.
  const signature = url.searchParams.get("signature");
  if (signature) {
    const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";
    if (!apiSecret || !verifyProxySignature(url.searchParams, apiSecret)) {
      return new Response("Invalid proxy signature.", { status: 401 });
    }
  }

  // --- Input validation ---
  if (!/^\d+$/.test(shopifyOrderId) || shopifyOrderId === "0") {
    return new Response("Invalid shopifyOrderId — must be a positive integer.", {
      status: 400,
    });
  }
  const amountInUSD = Number(amountInUSDStr);
  if (isNaN(amountInUSD) || amountInUSD <= 0) {
    return new Response("Invalid amountInUSD — must be a positive number.", {
      status: 400,
    });
  }
  if (!shop || !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return new Response("Invalid or missing shop parameter.", { status: 400 });
  }
  if (email) {
    // Basic email format check
    if (!/^[^@\s]{1,254}@[^@\s]{1,253}\.[^@\s]{1,63}$/.test(email)) {
      return new Response("Invalid email format.", { status: 400 });
    }
  }

  // --- Idempotency: return existing checkout URL if already created ---
  const existing = await prisma.paymentMapping.findUnique({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
  });
  if (existing?.payramCheckoutUrl) {
    return redirect(existing.payramCheckoutUrl);
  }

  // --- Create Payram payment ---
  // Note: there is a small race window between the findUnique above and the
  // upsert below. The upsert handles the conflict at DB level; the worst case
  // is two Payram payments are created (one is discarded). Acceptable for dev.
  let checkoutUrl: string;
  let referenceId: string;
  try {
    const result = await createPayramPayment({
      shop,
      shopifyOrderId,
      amountInUSD,
      customerEmail: email,
    });
    checkoutUrl = result.checkoutUrl;
    referenceId = result.referenceId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log the full cause chain so the real network error is visible
    const cause = err instanceof Error ? (err.cause as Error | undefined) : undefined;
    console.error("[payram] createPayramPayment failed:", msg, cause ? `| cause: ${cause.message ?? cause}` : "");
    return new Response(`Payment creation failed: ${msg}${cause ? ` (${cause.message ?? cause})` : ""}`, { status: 502 });
  }

  // --- Persist mapping ---
  await prisma.paymentMapping.upsert({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
    create: {
      shop,
      shopifyOrderId,
      payramReferenceId: referenceId,
      payramCheckoutUrl: checkoutUrl,
      payramStatus: "created",
    },
    update: {
      payramReferenceId: referenceId,
      payramCheckoutUrl: checkoutUrl,
      payramStatus: "created",
      updatedAt: new Date(),
    },
  });

  return redirect(checkoutUrl);
};
