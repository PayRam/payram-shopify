/**
 * Fiat → USD conversion for Payram payments.
 *
 * WHY THIS EXISTS
 * ---------------
 * Payram's POST /api/v1/payment accepts `amountInUSD` and nothing else — there
 * is no fiat currency field on the request. Payram's own rate oracle
 * (payram-core/pkg/utils/rate_oracle.go) converts *crypto* → USD only; it has
 * no notion of EUR, GBP, or any other fiat. So a connector talking to Payram
 * must convert the store's order total to USD itself, before creating the
 * payment.
 *
 * Without this module a €50 order was sent as `amountInUSD: 50` — the number
 * was passed through verbatim and only the variable name claimed it was USD.
 *
 * PARITY WITH THE WOOCOMMERCE CONNECTOR
 * -------------------------------------
 * This is a direct port of `to_usd()` / `get_usd_rate()` in
 * payram-woocommerce/includes/class-wc-gateway-payram.php:
 *   - same provider (open.er-api.com, free, no API key)
 *   - same one-hour cache TTL (Woo uses a WP transient, which is DB-backed;
 *     we use the FxRate table so the cache likewise survives restarts)
 *   - same fail-closed behaviour: no live rate ⇒ no payment, never a guess
 *
 * Rate movement between checkout and settlement is intentionally not hedged,
 * matching the WooCommerce connector's documented v1 behaviour.
 *
 * Rules: R-REUSE-FIRST (reuses the vetted WooCommerce provider choice and
 * Prisma's bundled decimal.js rather than adding a dependency), R-API-FOR-AGENTS
 * (errors below state what the caller should do next).
 */
import { Prisma } from "@prisma/client";
import prisma from "~/db.server";

/** open.er-api.com — free, no API key. Same provider as the WooCommerce connector. */
const FX_PROVIDER_URL = "https://open.er-api.com/v6/latest/USD";

/** Recorded on every conversion so a merchant can audit where a rate came from. */
export const FX_SOURCE = "open.er-api.com";

/** Cache lifetime for a fetched rate. Mirrors Woo's HOUR_IN_SECONDS transient. */
const RATE_TTL_MS = 60 * 60 * 1000;

/** Network budget for the rate lookup. Buyers are waiting on this call. */
const FX_TIMEOUT_MS = 15_000;

/** USD amounts are settled to cents. */
const USD_DECIMAL_PLACES = 2;

/**
 * Raised when no live rate can be obtained. The payment is aborted rather than
 * created at a guessed rate — an underpaid order is far more expensive to
 * unwind than a retried checkout.
 */
export class FxRateUnavailableError extends Error {
  readonly currency: string;

  constructor(currency: string, detail: string) {
    super(
      `Could not fetch a ${currency}→USD exchange rate (${detail}). ` +
        `The payment was not created. Ask the buyer to try again in a few moments; ` +
        `if this persists, check outbound network access to ${FX_SOURCE} from the app server.`,
    );
    this.name = "FxRateUnavailableError";
    this.currency = currency;
  }
}

export interface UsdConversion {
  /** Order total converted to USD, rounded to cents. */
  amountInUsd: Prisma.Decimal;
  /** Original amount, unchanged. */
  originalAmount: Prisma.Decimal;
  /** ISO-4217 code of the original amount, uppercased. */
  currency: string;
  /** USD value of one unit of `currency`. Exactly 1 for USD itself. */
  usdPerUnit: Prisma.Decimal;
  /** Provider the rate came from, or "identity" when no conversion was needed. */
  source: string;
}

/** ISO-4217 alphabetic codes are exactly three letters. */
function normalizeCurrency(currency: string): string {
  const code = (currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(
      `Unsupported currency code "${currency}". Expected a three-letter ISO-4217 code such as EUR.`,
    );
  }
  return code;
}

/**
 * USD value of one unit of `currency`, cached for an hour.
 * Returns null when no usable live rate could be obtained.
 */
async function getUsdRate(currency: string): Promise<Prisma.Decimal | null> {
  const now = new Date();

  const cached = await prisma.fxRate.findUnique({ where: { currency } });
  if (cached && cached.expiresAt > now) {
    return new Prisma.Decimal(cached.usdPerUnit);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(FX_PROVIDER_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[payram-fx] rate provider unreachable:", msg);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    console.error(`[payram-fx] rate provider returned HTTP ${res.status}`);
    return null;
  }

  let body: { result?: string; rates?: Record<string, unknown> };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    console.error("[payram-fx] rate provider returned invalid JSON");
    return null;
  }

  // open.er-api.com: rates[CUR] = units of CUR per 1 USD.
  // `new Prisma.Decimal("n/a")` throws, which would escape this module's
  // fail-closed contract and surface a raw library error to the buyer.
  const raw = body?.rates?.[currency];
  let perUsd: Prisma.Decimal | null = null;
  if (typeof raw === "number" || typeof raw === "string") {
    try {
      perUsd = new Prisma.Decimal(raw);
    } catch {
      console.error(`[payram-fx] non-numeric rate for ${currency}:`, raw);
      return null;
    }
  }

  if (!perUsd || !perUsd.isFinite() || perUsd.lessThanOrEqualTo(0)) {
    console.error(`[payram-fx] no usable rate for ${currency} in provider response`);
    return null;
  }

  // Invert to "USD per 1 unit of currency", the direction we multiply by.
  // 12 places keeps sub-cent accuracy for low-value currencies (e.g. IDR, VND).
  const usdPerUnit = new Prisma.Decimal(1).dividedBy(perUsd).toDecimalPlaces(12);

  // Single-statement upsert is atomic; a lost race just refetches an equal rate.
  await prisma.fxRate.upsert({
    where: { currency },
    create: {
      currency,
      usdPerUnit: usdPerUnit.toString(),
      source: FX_SOURCE,
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + RATE_TTL_MS),
    },
    update: {
      usdPerUnit: usdPerUnit.toString(),
      source: FX_SOURCE,
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + RATE_TTL_MS),
    },
  });

  return usdPerUnit;
}

/**
 * Convert a USD amount back into another currency.
 *
 * Used when settling: Payram reports what arrived in USD, but a gift card must
 * be denominated in the shop's own currency. Uses the same cached rate as the
 * forward direction, so a round trip is self-consistent.
 *
 * @throws {FxRateUnavailableError} when no live rate is available.
 */
export async function convertFromUsd(
  amountUsd: Prisma.Decimal | string | number,
  currency: string,
  decimalPlaces = 2,
): Promise<Prisma.Decimal> {
  const code = normalizeCurrency(currency);
  const usd = new Prisma.Decimal(amountUsd);

  if (code === "USD") {
    return usd.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
  }

  const usdPerUnit = await getUsdRate(code);
  if (!usdPerUnit) {
    throw new FxRateUnavailableError(code, `no live rate from ${FX_SOURCE}`);
  }

  return usd
    .dividedBy(usdPerUnit)
    .toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Convert a USD amount using a rate already recorded on the order.
 *
 * Preferred over {@link convertFromUsd} when a payment was struck at a known
 * rate: reusing the stored rate keeps "still due" figures stable instead of
 * drifting every time someone reloads the page, and keeps the arithmetic
 * consistent with the amount the buyer was originally quoted.
 */
export function convertFromUsdAtRate(
  amountUsd: Prisma.Decimal | string | number,
  usdPerUnit: Prisma.Decimal | string | number,
  decimalPlaces = 2,
): Prisma.Decimal {
  const rate = new Prisma.Decimal(usdPerUnit);
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) {
    throw new Error(`Invalid stored FX rate "${String(usdPerUnit)}".`);
  }
  return new Prisma.Decimal(amountUsd)
    .dividedBy(rate)
    .toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Convert an order total into USD for Payram.
 *
 * @throws {FxRateUnavailableError} when no live rate is available — callers must
 *   abort the payment rather than fall back to the unconverted number.
 */
export async function convertToUsd(
  amount: Prisma.Decimal | string | number,
  currency: string,
): Promise<UsdConversion> {
  const code = normalizeCurrency(currency);
  const originalAmount = new Prisma.Decimal(amount);

  if (!originalAmount.isFinite() || originalAmount.lessThanOrEqualTo(0)) {
    throw new Error(
      `Order total must be a positive amount; received "${String(amount)}" ${code}.`,
    );
  }

  if (code === "USD") {
    return {
      amountInUsd: originalAmount.toDecimalPlaces(USD_DECIMAL_PLACES),
      originalAmount,
      currency: code,
      usdPerUnit: new Prisma.Decimal(1),
      source: "identity",
    };
  }

  const usdPerUnit = await getUsdRate(code);
  if (!usdPerUnit) {
    throw new FxRateUnavailableError(code, `no live rate from ${FX_SOURCE}`);
  }

  const amountInUsd = originalAmount
    .times(usdPerUnit)
    .toDecimalPlaces(USD_DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);

  if (amountInUsd.lessThanOrEqualTo(0)) {
    // Guards against an order so small it rounds away entirely.
    throw new FxRateUnavailableError(
      code,
      `converted amount rounded to ${amountInUsd.toString()} USD`,
    );
  }

  return {
    amountInUsd,
    originalAmount,
    currency: code,
    usdPerUnit,
    source: FX_SOURCE,
  };
}
