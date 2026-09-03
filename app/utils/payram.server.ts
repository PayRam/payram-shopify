import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { decrypt } from "~/utils/encryption.server";

export interface PayramCreatePaymentInput {
  shop: string;
  shopifyOrderId: string;
  /**
   * Order total already converted to USD.
   *
   * Payram's API has no fiat currency field — `amountInUSD` is taken literally.
   * Callers MUST convert first (see `~/utils/fx.server`); passing a raw order
   * total in the store's currency silently books a EUR/GBP amount as dollars.
   */
  amountInUsd: Prisma.Decimal;
  customerEmail?: string;
}

export interface PayramCreatePaymentResult {
  checkoutUrl: string;
  referenceId: string;
}

export async function getMerchantConfig(shop: string) {
  return prisma.merchantConfig.findUnique({ where: { shop } });
}

/**
 * Validates a Payram base URL for SSRF safety.
 * Blocks private/loopback addresses and non-HTTPS protocols.
 * Set ALLOW_INSECURE_PAYRAM_URL=true to bypass in development only.
 */
export function validatePayramBaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid Payram base URL.");
  }

  if (process.env.ALLOW_INSECURE_PAYRAM_URL === "true") {
    return; // Dev escape hatch — never set in production
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Payram base URL must use HTTPS.");
  }

  // Basic SSRF protection: block private/loopback ranges and file://
  const h = parsed.hostname;
  const blockedPatterns = [
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "169.254.", // link-local
  ];
  const blockedPrefixes = [
    "192.168.",
    "10.",
    "172.16.",
    "172.17.",
    "172.18.",
    "172.19.",
    "172.20.",
    "172.21.",
    "172.22.",
    "172.23.",
    "172.24.",
    "172.25.",
    "172.26.",
    "172.27.",
    "172.28.",
    "172.29.",
    "172.30.",
    "172.31.",
  ];

  if (
    blockedPatterns.some((p) => h === p || h.startsWith(p)) ||
    blockedPrefixes.some((p) => h.startsWith(p))
  ) {
    throw new Error(
      "Payram base URL must not point to a private, loopback, or local address."
    );
  }
}

/**
 * Creates a Payram payment via the generic API.
 * POST {payramBaseUrl}/api/v1/payment
 *
 * Config resolution order:
 *  1. MerchantConfig row in DB (per-shop, set via the Settings page)
 *  2. PAYRAM_BASE_URL + PAYRAM_PROJECT_API_KEY env vars (dev convenience)
 */
export async function createPayramPayment(
  input: PayramCreatePaymentInput
): Promise<PayramCreatePaymentResult> {
  const config = await getMerchantConfig(input.shop);

  let baseUrlRaw: string;
  let apiKey: string;

  if (config) {
    baseUrlRaw = config.payramBaseUrl;
    apiKey = decrypt(config.payramProjectApiKeyEncrypted);
  } else if (process.env.PAYRAM_BASE_URL && process.env.PAYRAM_PROJECT_API_KEY) {
    baseUrlRaw = process.env.PAYRAM_BASE_URL;
    apiKey = process.env.PAYRAM_PROJECT_API_KEY;
  } else {
    throw new Error(
      `No Payram config found for shop: ${input.shop}. ` +
        "Either save credentials via the app Settings page, or set " +
        "PAYRAM_BASE_URL and PAYRAM_PROJECT_API_KEY in .env."
    );
  }

  const customerId = `shopify:${input.shop}:order:${input.shopifyOrderId}`;
  const baseUrl = baseUrlRaw.replace(/\/$/, "");
  const url = `${baseUrl}/api/v1/payment`;

  validatePayramBaseUrl(url);

  const body: Record<string, unknown> = {
    customerId,
    // Serialized as a JSON number, matching the WooCommerce connector's proven
    // payload shape. The value is already rounded to cents, so it is exactly
    // representable — all money arithmetic upstream is done in Decimal.
    amountInUSD: input.amountInUsd.toNumber(),
    // Surfaces the Shopify order number in the Payram dashboard for
    // reconciliation, as the WooCommerce connector does.
    invoiceID: input.shopifyOrderId,
  };
  if (input.customerEmail) {
    body.customerEmail = input.customerEmail;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-Key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Payram API error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as Record<string, unknown>;

  // Accept common field name variants from the Payram API response
  const checkoutUrl =
    (json.checkoutUrl as string | undefined) ??
    (json.checkout_url as string | undefined) ??
    (json.paymentUrl as string | undefined) ??
    (json.url as string | undefined);
  const referenceId =
    (json.referenceId as string | undefined) ??
    (json.reference_id as string | undefined) ??
    (json.id as string | undefined);

  if (!checkoutUrl || !referenceId) {
    throw new Error(
      `Unexpected Payram API response shape: ${JSON.stringify(json)}`
    );
  }

  return { checkoutUrl, referenceId };
}

/* ------------------------------------------------------------------ */
/* Verification — never mint value from an unsigned webhook            */
/* ------------------------------------------------------------------ */

export interface PayramPaymentSnapshot {
  paymentState: string | null;
  filledAmountInUsd: string | null;
  amountInUsd: string | null;
  /**
   * Payram's own customerId for this payment. The caller MUST check it against
   * the order it resolved, otherwise verifying only proves the reference exists
   * — not that the money belongs to this order.
   */
  customerId: string | null;
}

/** Non-negative money only — a negative fill would subtract from an order. */
function pickDecimalString(...values: unknown[]): string | null {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s && /^\d+(\.\d+)?$/.test(s)) return s;
  }
  return null;
}

/**
 * Read a payment's authoritative state straight from Payram.
 *
 * The merchant webhook carries no signature (see state/malicious-flows.md,
 * MF-004), so its amounts are attacker-controllable. Anything that moves money
 * — notably issuing a gift card for an overpayment — must be based on this,
 * not on the webhook body.
 *
 * This mirrors the WooCommerce connector's `fetch_payment_status()`, which
 * re-verifies for exactly the same reason.
 *
 * GET {payramBaseUrl}/api/v1/payment/reference/{referenceId}
 *
 * Returns null when the payment cannot be verified; callers must then refuse to
 * move money rather than fall back to the webhook's numbers.
 */
export async function fetchPayramPayment(
  shop: string,
  referenceId: string,
): Promise<PayramPaymentSnapshot | null> {
  const config = await getMerchantConfig(shop);

  let baseUrlRaw: string;
  let apiKey: string;
  if (config) {
    baseUrlRaw = config.payramBaseUrl;
    apiKey = decrypt(config.payramProjectApiKeyEncrypted);
  } else if (process.env.PAYRAM_BASE_URL && process.env.PAYRAM_PROJECT_API_KEY) {
    baseUrlRaw = process.env.PAYRAM_BASE_URL;
    apiKey = process.env.PAYRAM_PROJECT_API_KEY;
  } else {
    console.error(`[payram-verify] no Payram config for shop ${shop}`);
    return null;
  }

  const baseUrl = baseUrlRaw.replace(/\/$/, "");
  const url = `${baseUrl}/api/v1/payment/reference/${encodeURIComponent(referenceId)}`;

  try {
    validatePayramBaseUrl(url);
  } catch (err) {
    console.error("[payram-verify] base URL rejected:", err);
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "API-Key": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    console.error("[payram-verify] request failed:", err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    console.error(`[payram-verify] HTTP ${res.status} for reference ${referenceId}`);
    return null;
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json) {
    console.error("[payram-verify] unreadable response");
    return null;
  }

  // The two reference routes differ in casing: /payment/reference/:id returns
  // camelCase, /payment/ref/:id returns snake_case. Accept either.
  const state = json.paymentState ?? json.payment_state ?? json.status;
  const customerId = json.customerID ?? json.customerId ?? json.customer_id;

  return {
    customerId: typeof customerId === "string" ? customerId : null,
    paymentState: typeof state === "string" ? state : null,
    filledAmountInUsd: pickDecimalString(
      json.filledAmountInUSD,
      json.filledAmountInUsd,
      json.filled_amount_in_usd,
    ),
    amountInUsd: pickDecimalString(
      json.amountInUSD,
      json.amountInUsd,
      json.amount_in_usd,
    ),
  };
}
