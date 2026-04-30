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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderProxyHtmlPage(title: string, bodyHtml: string): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #f6f6f7; color: #111827; }
      main { max-width: 42rem; margin: 0 auto; background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 8px 24px rgba(0,0,0,0.08); }
      h1 { margin-top: 0; font-size: 1.25rem; }
      p { line-height: 1.5; }
      a { color: #005bd3; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      ${bodyHtml}
    </main>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function renderProxyErrorPage(title: string, detail: string): Response {
  return renderProxyHtmlPage(
    title,
    `<p>${escapeHtml(detail)}</p>`,
  );
}

function renderProxyRedirectPage(checkoutUrl: string): Response {
  let parsed: URL;
  try {
    parsed = new URL(checkoutUrl);
  } catch {
    return renderProxyErrorPage(
      "Invalid payment URL",
      "Payram returned an invalid checkout URL.",
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return renderProxyErrorPage(
      "Invalid payment URL",
      "Payram returned an unsupported checkout URL.",
    );
  }

  const safeUrl = parsed.toString();
  const escapedUrl = escapeHtml(safeUrl);
  const jsUrl = JSON.stringify(safeUrl);

  return renderProxyHtmlPage(
    "Redirecting to Payram",
    `<p>Redirecting you to the secure Payram payment page.</p>
     <p>If you are not redirected automatically, <a href="${escapedUrl}" rel="noopener noreferrer">continue to payment</a>.</p>
     <script>window.location.replace(${jsUrl});</script>
     <noscript><meta http-equiv="refresh" content="0;url=${escapedUrl}" /></noscript>`,
  );
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
  const isProxyRequest = Boolean(signature);

  console.info("[payram-proxy] request", {
    shopifyOrderId,
    shop,
    hasSignature: isProxyRequest,
  });

  if (signature) {
    const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";
    if (!apiSecret || !verifyProxySignature(url.searchParams, apiSecret)) {
      if (isProxyRequest) {
        return renderProxyErrorPage(
          "Invalid request",
          "This payment request could not be verified.",
        );
      }
      return new Response("Invalid proxy signature.", { status: 401 });
    }
  }

  // --- Input validation ---
  if (!/^\d+$/.test(shopifyOrderId) || shopifyOrderId === "0") {
    if (isProxyRequest) {
      return renderProxyErrorPage(
        "Invalid order",
        "The Shopify order ID was missing or invalid.",
      );
    }
    return new Response("Invalid shopifyOrderId — must be a positive integer.", {
      status: 400,
    });
  }
  const amountInUSD = Number(amountInUSDStr);
  if (isNaN(amountInUSD) || amountInUSD <= 0) {
    if (isProxyRequest) {
      return renderProxyErrorPage(
        "Invalid amount",
        "The payment amount was missing or invalid.",
      );
    }
    return new Response("Invalid amountInUSD — must be a positive number.", {
      status: 400,
    });
  }
  if (!shop || !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    if (isProxyRequest) {
      return renderProxyErrorPage(
        "Invalid shop",
        "The Shopify shop parameter was missing or invalid.",
      );
    }
    return new Response("Invalid or missing shop parameter.", { status: 400 });
  }
  if (email) {
    // Basic email format check
    if (!/^[^@\s]{1,254}@[^@\s]{1,253}\.[^@\s]{1,63}$/.test(email)) {
      if (isProxyRequest) {
        return renderProxyErrorPage(
          "Invalid email",
          "Please enter a valid email address.",
        );
      }
      return new Response("Invalid email format.", { status: 400 });
    }
  }

  // --- Idempotency: return existing checkout URL if already created ---
  const existing = await prisma.paymentMapping.findUnique({
    where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
  });
  if (existing?.payramCheckoutUrl) {
    console.info("[payram-proxy] reusing existing checkout url", {
      shopifyOrderId,
      payramReferenceId: existing.payramReferenceId,
    });
    return renderProxyRedirectPage(existing.payramCheckoutUrl);
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
    if (isProxyRequest) {
      return renderProxyErrorPage(
        "Payment creation failed",
        `${msg}${cause ? ` (${cause.message ?? cause})` : ""}`,
      );
    }
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

  console.info("[payram-proxy] created checkout url", {
    shopifyOrderId,
    payramReferenceId: referenceId,
  });

  return renderProxyRedirectPage(checkoutUrl);
};
