import prisma from "~/db.server";
import { decrypt } from "~/utils/encryption.server";

export interface PayramCreatePaymentInput {
  shop: string;
  shopifyOrderId: string;
  amountInUSD: number;
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
    amountInUSD: input.amountInUSD,
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
