import crypto from "node:crypto";
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

/** Where this shop's Payram lives and the key to use with it. */
interface PayramCredentials {
  /** Base URL without a trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** The stored config row; null when credentials came from the environment. */
  config: Awaited<ReturnType<typeof getMerchantConfig>>;
}

/**
 * Resolve a shop's Payram credentials.
 *
 *  1. MerchantConfig row in DB (per-shop, set via the Settings page)
 *  2. PAYRAM_BASE_URL + PAYRAM_PROJECT_API_KEY env vars (dev convenience)
 *
 * Returns null when neither exists. Throws when the stored key cannot be
 * decrypted (ENCRYPTION_KEY missing or changed).
 */
async function resolvePayramCredentials(
  shop: string,
): Promise<PayramCredentials | null> {
  const config = await getMerchantConfig(shop);
  if (config) {
    return {
      baseUrl: config.payramBaseUrl.replace(/\/$/, ""),
      apiKey: decrypt(config.payramProjectApiKeyEncrypted),
      config,
    };
  }
  if (process.env.PAYRAM_BASE_URL && process.env.PAYRAM_PROJECT_API_KEY) {
    return {
      baseUrl: process.env.PAYRAM_BASE_URL.replace(/\/$/, ""),
      apiKey: process.env.PAYRAM_PROJECT_API_KEY,
      config: null,
    };
  }
  return null;
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
  const credentials = await resolvePayramCredentials(input.shop);
  if (!credentials) {
    throw new Error(
      `No Payram config found for shop: ${input.shop}. ` +
        "Either save credentials via the app Settings page, or set " +
        "PAYRAM_BASE_URL and PAYRAM_PROJECT_API_KEY in .env."
    );
  }
  const { baseUrl, apiKey } = credentials;

  const customerId = `shopify:${input.shop}:order:${input.shopifyOrderId}`;
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

/**
 * What asking Payram about one reference produced.
 *
 * "Payram said no" and "Payram did not answer" must stay apart: the first is
 * final (a webhook for it is answered 200 so Payram stops resending), the
 * second is temporary (answered 503 so Payram's webhook processor retries).
 * Folding both into one `null` is what let an unreachable Payram look the same
 * as a forged reference.
 */
export type PayramLookup =
  | { status: "found"; payment: PayramPaymentSnapshot }
  /** Payram answered: it has no payment under this reference. */
  | { status: "not_found"; httpStatus: number }
  /** No answer: no config, a rejected URL, the network, a timeout, a 5xx. */
  | { status: "unavailable"; reason: string };

/**
 * Statuses that are Payram answering "no such payment".
 *
 * payram-core's PaymentRequestMiddleware answers 401 for a reference it does
 * not have (internal/api/middleware/payment_request_middleware.go). 404 and 410
 * mean the same from a proxy or an older core. Everything else that is not 2xx
 * — 403 from a firewall, 429, 5xx — is treated as no answer, because calling a
 * real payment "not found" is the expensive mistake: it stops Payram's retries.
 */
const NOT_FOUND_STATUSES = new Set([401, 404, 410]);

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
 * The merchant webhook's body is attacker-controllable (see
 * state/malicious-flows.md, MF-004 and MF-012), so nothing that counts money,
 * tags an order or mints a gift card may come from it. It must come from this.
 *
 * This mirrors the WooCommerce connector's `fetch_payment_status()`, which
 * re-verifies for exactly the same reason.
 *
 * GET {payramBaseUrl}/api/v1/payment/reference/{referenceId}
 *
 * Never throws. The caller still has to check `payment.customerId` belongs to
 * the order before using the figures.
 */
export async function fetchPayramPayment(
  shop: string,
  referenceId: string,
): Promise<PayramLookup> {
  let credentials: PayramCredentials | null;
  try {
    credentials = await resolvePayramCredentials(shop);
  } catch (err) {
    console.error(`[payram-verify] could not read the Payram config for ${shop}:`, err);
    return { status: "unavailable", reason: "the saved Payram API key could not be read" };
  }
  if (!credentials) {
    console.error(`[payram-verify] no Payram config for shop ${shop}`);
    return { status: "unavailable", reason: "no Payram server is configured" };
  }

  const url = `${credentials.baseUrl}/api/v1/payment/reference/${encodeURIComponent(referenceId)}`;

  try {
    validatePayramBaseUrl(url);
  } catch (err) {
    console.error("[payram-verify] base URL rejected:", err);
    return { status: "unavailable", reason: "the Payram Base URL is not allowed" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "API-Key": credentials.apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    console.error("[payram-verify] request failed:", err);
    return { status: "unavailable", reason: "Payram could not be reached" };
  } finally {
    clearTimeout(timeoutId);
  }

  if (NOT_FOUND_STATUSES.has(res.status)) {
    console.warn(`[payram-verify] Payram has no payment ${referenceId} (HTTP ${res.status})`);
    return { status: "not_found", httpStatus: res.status };
  }
  if (!res.ok) {
    console.error(`[payram-verify] HTTP ${res.status} for reference ${referenceId}`);
    return { status: "unavailable", reason: `Payram answered HTTP ${res.status}` };
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") {
    console.error("[payram-verify] unreadable response");
    return { status: "unavailable", reason: "Payram's answer could not be read" };
  }

  // The two reference routes differ in casing: /payment/reference/:id returns
  // camelCase, /payment/ref/:id returns snake_case. Accept either.
  const state = json.paymentState ?? json.payment_state ?? json.status;
  const customerId = json.customerID ?? json.customerId ?? json.customer_id;

  return {
    status: "found",
    payment: {
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
    },
  };
}

/* ------------------------------------------------------------------ */
/* Webhook signatures                                                  */
/* ------------------------------------------------------------------ */

/**
 * payram-core 3.9.0+ adds this to every webhook it sends — payment, payout and
 * ping (pkg/utils/utils.go → signWebhook): `sha256=<hex HMAC-SHA256 of the raw
 * body, keyed with the project API key>`.
 */
const PAYRAM_SIGNATURE_HEADER = "X-Payram-Signature";

/** Does `header` sign exactly these bytes with `apiKey`? Constant-time. */
export function isPayramSignatureValid(
  rawBody: Uint8Array,
  header: string,
  apiKey: string,
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = crypto.createHmac("sha256", apiKey).update(rawBody).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export type WebhookAuthentication =
  /** Signed with this shop's saved API key. */
  | { outcome: "signed" }
  /**
   * Not proven to come from Payram, but not refused: this shop has never
   * received a correctly signed webhook, so its Payram may predate signing.
   * Everything in it must still be confirmed with Payram before it counts.
   */
  | { outcome: "unauthenticated"; signatureMismatch: boolean }
  /** This shop's Payram signs its webhooks, and this one is not signed by it. */
  | { outcome: "refused"; message: string };

/** A refused signed webhook is recorded at most this often per shop. */
const REFUSED_WEBHOOK_RECORD_INTERVAL_MS = 60_000;

/**
 * Note, for the merchant, that a webhook signed with another key was refused.
 *
 * What this means in practice: the Payram project has a newer admin API key
 * than the one saved in the app, so every genuine payment webhook now fails
 * with 401, and Payram gives up resending after about 48 hours. The settings
 * page turns this time into a warning to save the project's current key.
 *
 * The body is never read for it and nothing about the payment is written —
 * the caller may be anyone. One timestamp, at most once a minute per shop,
 * so a flood of refused requests cannot turn into a flood of writes. A
 * failure here never changes the 401.
 */
async function recordRefusedSignedWebhook(shop: string): Promise<void> {
  const now = new Date();
  try {
    await prisma.merchantConfig.updateMany({
      where: {
        shop,
        signedWebhooksSince: { not: null },
        OR: [
          { signedWebhookRefusedAt: null },
          { signedWebhookRefusedAt: { lt: new Date(now.getTime() - REFUSED_WEBHOOK_RECORD_INTERVAL_MS) } },
        ],
      },
      data: { signedWebhookRefusedAt: now },
    });
  } catch (err) {
    console.error(`[payram-webhook] ${shop}: could not record a refused signed webhook:`, err);
  }
}

/**
 * Decide whether a webhook body may be acted on at all.
 *
 * WHY NOT SIMPLY REQUIRE THE SIGNATURE
 * ------------------------------------
 * Payram releases before 3.9.0 do not sign, so requiring it would stop every
 * order on those servers from settling. And payram-core signs with the
 * project's NEWEST active admin key (api_key_repo_impl.go →
 * GetByExternalPlatformId), so a merchant who pasted an older key of the same
 * project would see every genuine webhook fail. Refusing from day one would
 * break both silently.
 *
 * So the shop is trusted to sign once it has proven it does: the first webhook
 * that verifies with the saved key records `signedWebhooksSince`, and from then
 * on an unsigned or wrongly signed webhook is refused before anything is read
 * or written. Until then a webhook is accepted as unauthenticated — which costs
 * little, because nothing in an unauthenticated body is ever believed: every
 * reference is confirmed with Payram before it can count (MF-012).
 *
 * Saving a different Payram URL or API key clears the record, so moving to a
 * new server cannot leave the shop refusing that server's webhooks.
 *
 * A refused webhook that IS signed — with a key other than the saved one — is
 * what a newer admin key on the project looks like, so it is recorded on the
 * shop (`signedWebhookRefusedAt`) for the settings page to warn about; the
 * next correctly signed webhook clears it.
 *
 * Rules: R-MALICIOUS-FLOW (MF-013), R-API-FOR-AGENTS.
 */
export async function authenticateWebhook(
  shop: string,
  rawBody: Uint8Array,
  headers: Headers,
): Promise<WebhookAuthentication> {
  let credentials: PayramCredentials | null = null;
  try {
    credentials = await resolvePayramCredentials(shop);
  } catch (err) {
    // An unreadable key cannot verify anything; Payram confirmation will fail
    // the same way and say so.
    console.error(`[payram-webhook] could not read the Payram config for ${shop}:`, err);
  }

  const signature = headers.get(PAYRAM_SIGNATURE_HEADER)?.trim() || null;
  const signedSince = credentials?.config?.signedWebhooksSince ?? null;

  if (signature && credentials && isPayramSignatureValid(rawBody, signature, credentials.apiKey)) {
    if (credentials.config && !signedSince) {
      // Single statement, atomic on its own. The `null` guard keeps the first
      // timestamp if two signed deliveries race.
      await prisma.merchantConfig.updateMany({
        where: { shop, signedWebhooksSince: null },
        data: { signedWebhooksSince: new Date() },
      });
      console.info(
        `[payram-webhook] ${shop}: first correctly signed Payram webhook — unsigned ones are refused from now on`,
      );
    }
    if (credentials.config?.signedWebhookRefusedAt) {
      // Payram signs with the saved key again: the warning is over.
      await prisma.merchantConfig.updateMany({
        where: { shop, signedWebhookRefusedAt: { not: null } },
        data: { signedWebhookRefusedAt: null },
      });
      console.info(`[payram-webhook] ${shop}: webhooks verify with the saved API key again`);
    }
    return { outcome: "signed" };
  }

  if (signedSince) {
    if (signature) await recordRefusedSignedWebhook(shop);
    return {
      outcome: "refused",
      message: signature
        ? "Webhook signature does not match the Payram API key saved in the Shopify app, so " +
          "nothing was recorded. If the API key was changed in Payram, save the current key " +
          "in the Payram app in Shopify Admin; Payram will resend this webhook."
        : "Webhook is not signed. This store's Payram signs its webhooks, so an unsigned one " +
          "is refused and nothing was recorded.",
    };
  }

  if (signature) {
    console.warn(
      `[payram-webhook] ${shop}: webhook signature does not match the saved Payram API key. ` +
        "Accepting it unauthenticated (every amount is still confirmed with Payram). " +
        "Save the project's current API key in settings to have unsigned webhooks refused.",
    );
  }
  return { outcome: "unauthenticated", signatureMismatch: Boolean(signature) };
}
