/**
 * GET /api/payram/redirect-to-payment
 *
 * Called by the buyer's browser when they click "Open Payram checkout" in
 * the Thank You page extension. Creates (or retrieves) a Payram payment link
 * for the order and redirects the buyer.
 *
 * Query params:
 *   shopifyOrderId  — numeric Shopify order ID (required)
 *   amountInUSD     — order total in USD (required)
 *   shop            — myshopify.com domain of the merchant (required)
 *   email           — buyer email, optional
 *
 * Security notes:
 *   - No Shopify auth required; this is called by the buyer's browser.
 *   - Rate-limiting per IP should be applied at the reverse-proxy layer in prod.
 *   - shopifyOrderId/amountInUSD come from the extension (Shopify-signed iframe),
 *     but are not independently verified here. For production hardening, add a
 *     short-lived HMAC token signed by the app backend and verified here.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import prisma from "~/db.server";
import { createPayramPayment } from "~/utils/payram.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopifyOrderId = url.searchParams.get("shopifyOrderId") ?? "";
  const amountInUSDStr = url.searchParams.get("amountInUSD") ?? "";
  const shop = url.searchParams.get("shop") ?? "";
  const email = url.searchParams.get("email") ?? undefined;

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
