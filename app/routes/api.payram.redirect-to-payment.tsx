/**
 * GET /api/payram/redirect-to-payment
 *
 * The entry point from the Thank You block. It no longer does any work — it
 * validates, records the buyer's email, mints a signed token and hands off to
 * `/pay/{token}?auto=1`, which is the durable payment page.
 *
 * WHY THIS ROUTE STILL EXISTS
 * ---------------------------
 * Checkout extension bundles are deployed separately from the server, so
 * merchants running an older bundle still link here. Keeping this URL means the
 * new flow reaches them the moment the server updates, with no extension
 * redeploy. Any `amountInUSD` such a bundle sends is ignored — the amount is
 * always read from Shopify server-side.
 *
 * Everything the old version did inline (Admin API lookup, FX conversion, Payram
 * create) now happens behind the payment page, so the buyer sees a rendered page
 * immediately instead of a blank tab.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import prisma from "~/db.server";
import { signOrderToken } from "~/utils/order-token.server";

const EMAIL_RE = /^[^@\s]{1,254}@[^@\s]{1,253}\.[^@\s]{1,63}$/;

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

function errorPage(title: string, detail: string, status: number): Response {
  const esc = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Poppins:wght@600;700&display=swap">
<style>
 /* Payram tokens — see payram-frontend/src/styles/themes.css */
 :root{--pr-bg:#f1f5f9;--pr-surface:#fff;--pr-text:#0f172a;--pr-text-secondary:#475569;--pr-border:#e2e8f0;--pr-primary:#09984E;--pr-primary-soft:rgba(1,228,111,.10)}
 @media(prefers-color-scheme:dark){:root{--pr-bg:#0f172a;--pr-surface:#1e293b;--pr-text:#f1f5f9;--pr-text-secondary:#94a3b8;--pr-border:#334155;--pr-primary:#01E46F;--pr-primary-soft:rgba(1,228,111,.12)}}
 body{margin:0;background:var(--pr-bg);color:var(--pr-text);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;padding:2rem;display:flex;justify-content:center;-webkit-font-smoothing:antialiased}
 main{width:100%;max-width:30rem;background:var(--pr-surface);border:1px solid var(--pr-border);border-radius:16px;padding:1.75rem;box-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px rgba(15,23,42,.06)}
 .brand{display:flex;align-items:center;gap:.55rem;font-family:Poppins,Inter,sans-serif;font-weight:700;font-size:.82rem;letter-spacing:.14em;text-transform:uppercase;color:var(--pr-text-secondary);margin-bottom:1rem}
 .brand::before{content:"";width:.65rem;height:.65rem;border-radius:3px;background:var(--pr-primary);box-shadow:0 0 0 3px var(--pr-primary-soft)}
 h1{font-family:Poppins,Inter,sans-serif;font-size:1.3rem;font-weight:600;margin:0 0 .6rem;letter-spacing:-.01em}
 p{margin:0;color:var(--pr-text-secondary);line-height:1.55}
</style></head><body><main><div class="brand">Payram</div><h1>${esc(title)}</h1><p>${esc(detail)}</p></main></body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopifyOrderId = url.searchParams.get("shopifyOrderId") ?? "";
  const shop = url.searchParams.get("shop") ?? "";
  const email = (url.searchParams.get("email") ?? "").trim();

  // Present only when the request came via the Shopify App Proxy. The extension
  // navigates to the app URL directly, so it is usually absent; when present it
  // must be valid.
  const signature = url.searchParams.get("signature");
  if (signature) {
    const apiSecret = process.env.SHOPIFY_API_SECRET ?? "";
    if (!apiSecret || !verifyProxySignature(url.searchParams, apiSecret)) {
      return errorPage(
        "Invalid request",
        "This payment request could not be verified. Please return to your order confirmation and try again.",
        401,
      );
    }
  }

  if (!/^\d+$/.test(shopifyOrderId) || shopifyOrderId === "0") {
    return errorPage(
      "Invalid order",
      "The order reference was missing or invalid. Please return to your order confirmation and try again.",
      400,
    );
  }
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return errorPage(
      "Invalid store",
      "The store reference was missing or invalid. Please return to your order confirmation and try again.",
      400,
    );
  }
  if (email && !EMAIL_RE.test(email)) {
    return errorPage(
      "Invalid email",
      "Please go back and enter a valid email address.",
      400,
    );
  }

  // Hold the email against the order — but only ever as an UPDATE to a row that
  // already exists, and never over one already set.
  //
  // This route is unauthenticated (MF-003) and order IDs are guessable, so an
  // upsert here would let anyone (a) fabricate PaymentMapping rows for arbitrary
  // order IDs, which then show up in the merchant's dashboard, and (b) overwrite
  // a real buyer's receipt address with their own. `updateMany` touches nothing
  // when no row matches, which is exactly the desired no-op.
  if (email) {
    await prisma.paymentMapping
      .updateMany({
        where: { shop, shopifyOrderId, buyerEmail: null },
        data: { buyerEmail: email, updatedAt: new Date() },
      })
      .catch((err) => {
        // Not fatal: the email is a convenience for Payram's receipt.
        console.error("[payram-entry] could not store buyer email:", err);
      });
  }

  let token: string;
  try {
    token = signOrderToken({ shop, shopifyOrderId });
  } catch (err) {
    console.error("[payram-entry] token signing failed:", err);
    return errorPage(
      "Payments are not configured",
      "This store cannot create payment links right now. Please contact the store.",
      503,
    );
  }

  console.info("[payram-entry] issuing payment page", { shop, shopifyOrderId });

  // `auto=1`: the buyer just pressed "pay", so the page proceeds to checkout
  // rather than stopping to show status.
  //
  // The email rides along for this one hop so a buyer's very first payment still
  // reaches Payram with a receipt address even though nothing is stored yet
  // (see above). The payment page strips it from the URL on load, so what the
  // buyer can bookmark never contains an email address.
  const params = new URLSearchParams({ auto: "1" });
  if (email) params.set("email", email);

  // App Proxy requests originate on the storefront domain, where a root-relative
  // Location would resolve to https://{shop}/pay/... and 404. Absolute when the
  // app URL is known.
  const appUrl = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
  const target = `/pay/${token}?${params}`;
  const location = signature && appUrl ? `${appUrl}${target}` : target;

  return redirect(location, {
    headers: { "Cache-Control": "no-store" },
  });
};
