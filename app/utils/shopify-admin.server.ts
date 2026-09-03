/**
 * Shopify Admin API helpers.
 *
 * Two jobs:
 *  1. Read the authoritative order total + presentment currency when creating a
 *     Payram payment. The buyer's browser must never be the source of the amount.
 *  2. Sync a completed Payram payment back into Shopify by tagging the order.
 *     This avoids the PCD-gated orderMarkAsPaid mutation while still giving
 *     merchants a visible signal in Shopify Admin.
 */
import prisma from "~/db.server";
import { sessionStorage } from "~/shopify.server";

const SHOPIFY_API_VERSION = "2025-01";
const PAYRAM_PAID_TAG = "payram_paid";

/** Admin API budget. The buyer is waiting on the order lookup. */
const ADMIN_TIMEOUT_MS = 15_000;

/**
 * The offline (persistent) access token for a shop. Online sessions are
 * user-scoped and absent for buyer-initiated and webhook-initiated traffic.
 *
 * Returns null when the app has no offline grant — the shop must reinstall.
 */
export async function findOfflineAccessToken(
  shop: string,
): Promise<string | null> {
  const sessions = await sessionStorage.findSessionsByShop(shop);
  const offlineSession = sessions.find((s) => !s.isOnline && s.accessToken);
  return offlineSession?.accessToken ?? null;
}

/**
 * Run a GraphQL operation against a shop's Admin API.
 *
 * Returns the `data` payload. Throws with buyer/merchant-safe wording; the
 * detail is logged, never surfaced (R-API-FOR-AGENTS).
 */
async function adminGraphql<T>(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ADMIN_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[payram-admin] ${label} network error:`, msg);
    throw new Error(`Could not reach Shopify (${label}). Please try again shortly.`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    console.error(`[payram-admin] ${label} HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "This store's Payram app authorization has expired or is missing a required " +
          "permission. Reopen the Payram app in Shopify Admin to reconnect it.",
      );
    }
    throw new Error(`Shopify rejected the ${label} request (HTTP ${res.status}).`);
  }

  const json = (await res.json().catch(() => null)) as {
    data?: T;
    errors?: { message?: string }[];
  } | null;

  if (!json) {
    throw new Error(`Shopify returned an unreadable response (${label}).`);
  }
  if (json.errors?.length) {
    const detail = json.errors.map((e) => e.message).join("; ");
    console.error(`[payram-admin] ${label} GraphQL errors:`, detail);
    throw new Error(
      `Shopify rejected the ${label} request. If this persists, the merchant should ` +
        "reopen the Payram app in Shopify Admin to refresh its permissions.",
    );
  }
  if (!json.data) {
    throw new Error(`Shopify returned no data (${label}).`);
  }
  return json.data;
}

/** Order total as Shopify reports it, in the currency the buyer was charged. */
export interface ShopifyOrderTotal {
  /** Human-facing order name, e.g. "#1001". */
  orderName: string | null;
  /** Amount still due as a decimal string, e.g. "50.00". Zero when settled. */
  amount: string;
  /** ISO-4217 presentment currency, e.g. "EUR" — what the buyer actually saw. */
  currencyCode: string;
  /**
   * True when Shopify reports nothing left to pay — a gift card covered it, or
   * the merchant marked the order paid in Admin. Callers must show a paid state
   * rather than trying to charge again.
   */
  fullyPaidInShopify: boolean;
}

/**
 * What to charge is the amount STILL DUE, not the order total.
 *
 * `totalOutstandingSet` is "the sum of the line prices, taxes, and shipping minus
 * discounts and gift cards" — so if a buyer applied a gift card (including one we
 * issued them for an earlier partial payment) or anything else already paid down
 * the order, this is the only field that reflects it. Charging
 * `currentTotalPriceSet` would bill them for the full total a second time.
 *
 * `currentTotalPriceSet` (post-edit total) and `totalPriceSet` (original) remain
 * as fallbacks for the ordinary case where nothing has been paid.
 *
 * presentmentMoney throughout: the currency the buyer was invoiced in, which is
 * what they expect to pay. shopMoney is the shop's default and can differ under
 * Shopify Markets.
 */
const ORDER_TOTAL_QUERY = /* graphql */ `
  query payramOrderTotal($id: ID!) {
    order(id: $id) {
      id
      name
      totalOutstandingSet {
        presentmentMoney {
          amount
          currencyCode
        }
      }
      currentTotalPriceSet {
        presentmentMoney {
          amount
          currencyCode
        }
      }
      totalPriceSet {
        presentmentMoney {
          amount
          currencyCode
        }
      }
    }
  }
`;

interface MoneyV2 {
  amount?: string;
  currencyCode?: string;
}

/**
 * Fetch an order's authoritative total from Shopify.
 *
 * Errors are thrown with actionable messages (R-API-FOR-AGENTS): the caller
 * surfaces them to the buyer and the merchant, so they must say what to do next
 * without leaking internals.
 */
export async function fetchOrderTotal(
  shop: string,
  accessToken: string,
  shopifyOrderId: string,
): Promise<ShopifyOrderTotal> {
  const gid = `gid://shopify/Order/${shopifyOrderId}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ADMIN_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: ORDER_TOTAL_QUERY,
          variables: { id: gid },
        }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[payram-admin] order lookup network error:", msg);
    throw new Error(
      "Could not reach Shopify to confirm the order total. Please try again in a moment.",
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    console.error(`[payram-admin] order lookup returned HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "This store's Payram app authorization has expired. The merchant needs to reopen " +
          "the Payram app in Shopify Admin to reconnect it.",
      );
    }
    throw new Error(
      "Shopify could not confirm the order total right now. Please try again in a moment.",
    );
  }

  const json = (await res.json().catch(() => null)) as {
    data?: {
      order?: {
        name?: string;
        totalOutstandingSet?: { presentmentMoney?: MoneyV2 };
        currentTotalPriceSet?: { presentmentMoney?: MoneyV2 };
        totalPriceSet?: { presentmentMoney?: MoneyV2 };
      } | null;
    };
    errors?: { message?: string }[];
  } | null;

  if (!json) {
    throw new Error(
      "Shopify returned an unreadable response for this order. Please try again in a moment.",
    );
  }

  if (json.errors?.length) {
    // GraphQL errors here mean a bad query or a missing scope — merchant-fixable,
    // so log the detail but keep the buyer-facing message generic.
    console.error(
      "[payram-admin] order lookup GraphQL errors:",
      json.errors.map((e) => e.message).join("; "),
    );
    throw new Error(
      "Shopify rejected the order lookup. If this persists, the merchant should " +
        "reopen the Payram app in Shopify Admin to refresh its permissions.",
    );
  }

  const order = json.data?.order;
  if (!order) {
    throw new Error(
      `Order ${shopifyOrderId} was not found on ${shop}. It may have been deleted, ` +
        "or the payment link may belong to a different store.",
    );
  }

  const outstanding = order.totalOutstandingSet?.presentmentMoney;
  const outstandingAmount = outstanding?.amount
    ? Number(outstanding.amount)
    : Number.NaN;

  // An outstanding balance of exactly zero means the order is already covered —
  // by a gift card, a prior payment, or a manual capture. That is a normal state
  // (merchants do mark crypto orders paid in Admin), so it is reported rather
  // than thrown: throwing here broke the buyer's durable payment page with a
  // generic 500 for an order that was simply already paid.
  const fullyPaidInShopify =
    Number.isFinite(outstandingAmount) && outstandingAmount <= 0;

  const money =
    (Number.isFinite(outstandingAmount) && outstandingAmount > 0
      ? outstanding
      : null) ??
    order.currentTotalPriceSet?.presentmentMoney ??
    order.totalPriceSet?.presentmentMoney;

  if (!money?.amount || !money?.currencyCode) {
    throw new Error(
      `Shopify did not report a total for order ${shopifyOrderId}. Please try again in a moment.`,
    );
  }

  return {
    orderName: order.name ?? null,
    amount: money.amount,
    currencyCode: money.currencyCode,
    fullyPaidInShopify,
  };
}

const TAGS_ADD_MUTATION = /* graphql */ `
  mutation addTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

interface SyncOrderTagResult {
  ok: boolean;
  tag?: string;
  error?: string;
}

export async function tagShopifyOrderPaid(
  shop: string,
  accessToken: string,
  shopifyOrderId: string,
  mappingId: string
): Promise<SyncOrderTagResult> {
  const gid = `gid://shopify/Order/${shopifyOrderId}`;

  let res: Response;
  try {
    res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: TAGS_ADD_MUTATION,
          variables: { id: gid, tags: [PAYRAM_PAID_TAG] },
        }),
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.paymentMapping.update({
      where: { id: mappingId },
      data: { syncError: `Network error: ${msg}`, lastSyncAt: new Date() },
    });
    return { ok: false, error: msg };
  }

  if (!res.ok) {
    const msg = `Shopify Admin API HTTP ${res.status}`;
    await prisma.paymentMapping.update({
      where: { id: mappingId },
      data: { syncError: msg, lastSyncAt: new Date() },
    });
    return { ok: false, error: msg };
  }

  const json = (await res.json()) as {
    data?: {
      tagsAdd?: {
        node?: { id: string };
        userErrors?: { message: string }[];
      };
    };
    errors?: unknown;
  };

  const userErrors = json.data?.tagsAdd?.userErrors ?? [];
  if (userErrors.length > 0) {
    const msg = userErrors.map((e) => e.message).join("; ");
    await prisma.paymentMapping.update({
      where: { id: mappingId },
      data: { syncError: msg, lastSyncAt: new Date() },
    });
    return { ok: false, error: msg };
  }

  const node = json.data?.tagsAdd?.node;
  if (node) {
    await prisma.paymentMapping.update({
      where: { id: mappingId },
      data: {
        // Legacy field: now stores the Shopify order tag used for external
        // payment reconciliation rather than a financial status string.
        shopifyFinancialStatus: PAYRAM_PAID_TAG,
        shopifyPaidSyncedAt: new Date(),
        lastSyncAt: new Date(),
        syncError: null,
      },
    });
    return { ok: true, tag: PAYRAM_PAID_TAG };
  }

  return { ok: false, error: "No order data in response" };
}

/* ------------------------------------------------------------------ */
/* Settlement helpers — used when a Payram payment lands               */
/* ------------------------------------------------------------------ */

/** What the connector needs to settle an order after a payment arrives. */
export interface OrderSettlementContext {
  orderName: string | null;
  /** Existing merchant note, so we append rather than overwrite. */
  note: string | null;
  /** Customer GID, when the order has one. Guest checkouts usually still have one. */
  customerId: string | null;
  /** The shop's own currency — the denomination a gift card must be issued in. */
  shopCurrencyCode: string | null;
}

const ORDER_CONTEXT_QUERY = /* graphql */ `
  query payramOrderContext($id: ID!) {
    order(id: $id) {
      id
      name
      note
      customer { id }
      totalPriceSet { shopMoney { currencyCode } }
    }
  }
`;

// Protected Customer Data can block the `customer` field on unapproved apps.
// Falling back keeps settlement working (tags, notes) without the customer link.
const ORDER_CONTEXT_QUERY_NO_CUSTOMER = /* graphql */ `
  query payramOrderContextBasic($id: ID!) {
    order(id: $id) {
      id
      name
      note
      totalPriceSet { shopMoney { currencyCode } }
    }
  }
`;

interface OrderContextData {
  order?: {
    name?: string;
    note?: string | null;
    customer?: { id?: string } | null;
    totalPriceSet?: { shopMoney?: { currencyCode?: string } };
  } | null;
}

export async function fetchOrderSettlementContext(
  shop: string,
  accessToken: string,
  shopifyOrderId: string,
): Promise<OrderSettlementContext> {
  const gid = `gid://shopify/Order/${shopifyOrderId}`;

  let data: OrderContextData;
  try {
    data = await adminGraphql<OrderContextData>(
      shop,
      accessToken,
      ORDER_CONTEXT_QUERY,
      { id: gid },
      "order context",
    );
  } catch {
    // Most likely PCD gating on `customer`. Retry without it.
    console.warn(
      "[payram-admin] order context with customer failed; retrying without customer field",
    );
    data = await adminGraphql<OrderContextData>(
      shop,
      accessToken,
      ORDER_CONTEXT_QUERY_NO_CUSTOMER,
      { id: gid },
      "order context (basic)",
    );
  }

  const order = data.order;
  if (!order) {
    throw new Error(`Order ${shopifyOrderId} was not found on ${shop}.`);
  }

  return {
    orderName: order.name ?? null,
    note: order.note ?? null,
    customerId: order.customer?.id ?? null,
    shopCurrencyCode: order.totalPriceSet?.shopMoney?.currencyCode ?? null,
  };
}

/** Add tags to an order. Shopify de-duplicates, so this is safe to repeat. */
export async function addOrderTags(
  shop: string,
  accessToken: string,
  shopifyOrderId: string,
  tags: string[],
): Promise<void> {
  if (tags.length === 0) return;
  const data = await adminGraphql<{
    tagsAdd?: { userErrors?: { message: string }[] };
  }>(
    shop,
    accessToken,
    TAGS_ADD_MUTATION,
    { id: `gid://shopify/Order/${shopifyOrderId}`, tags },
    "add order tags",
  );
  const errs = data.tagsAdd?.userErrors ?? [];
  if (errs.length) {
    throw new Error(errs.map((e) => e.message).join("; "));
  }
}

const ORDER_NOTE_MUTATION = /* graphql */ `
  mutation payramOrderNote($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { message }
    }
  }
`;

/**
 * Append a line to the order's note.
 *
 * Appends rather than replaces: the note field is merchant-owned, and silently
 * overwriting a merchant's own notes to record our own would be destructive.
 * Idempotent — a line already present is not added twice, so webhook retries
 * don't stack duplicates.
 */
export async function appendOrderNote(
  shop: string,
  accessToken: string,
  shopifyOrderId: string,
  existingNote: string | null,
  line: string,
): Promise<void> {
  const current = existingNote ?? "";
  if (current.includes(line)) return;

  const next = current.trim() ? `${current.trim()}\n${line}` : line;

  const data = await adminGraphql<{
    orderUpdate?: { userErrors?: { message: string }[] };
  }>(
    shop,
    accessToken,
    ORDER_NOTE_MUTATION,
    { input: { id: `gid://shopify/Order/${shopifyOrderId}`, note: next } },
    "update order note",
  );
  const errs = data.orderUpdate?.userErrors ?? [];
  if (errs.length) {
    throw new Error(errs.map((e) => e.message).join("; "));
  }
}

/* ------------------------------------------------------------------ */
/* Gift cards — how an overpayment is returned to the buyer            */
/* ------------------------------------------------------------------ */

const GIFT_CARD_CREATE_MUTATION = /* graphql */ `
  mutation payramGiftCardCreate($input: GiftCardCreateInput!) {
    giftCardCreate(input: $input) {
      giftCard {
        id
        lastCharacters
        balance { amount currencyCode }
      }
      userErrors { field message }
    }
  }
`;

export interface GiftCardResult {
  id: string;
  /** Last characters of the code, for merchant reference. Never the full code. */
  lastCharacters: string | null;
  amount: string | null;
  currencyCode: string | null;
  /** True when Shopify was asked to email the card to the customer. */
  notified: boolean;
}

interface GiftCardData {
  giftCardCreate?: {
    giftCard?: {
      id?: string;
      lastCharacters?: string;
      balance?: { amount?: string; currencyCode?: string };
    } | null;
    userErrors?: { field?: string[]; message: string }[];
  };
}

/**
 * Issue a gift card for an overpaid amount.
 *
 * Gift cards are the right instrument here rather than store credit: a gift card
 * is a code, so it works for guest buyers, who cannot spend store credit (that
 * requires signing in through customer accounts or Shop Pay).
 *
 * When the order has a customer, `recipientAttributes` asks Shopify to email the
 * card directly — that is what makes this automatic. If that field is rejected
 * (older API surface, or PCD limits), the card is still created without it so
 * the value is never lost; the merchant delivers it from Admin instead.
 *
 * NOTE: the full gift card code is intentionally not requested or stored. It is
 * bearer value — anyone holding it can spend it. Shopify remains its custodian.
 */
export async function createGiftCard(
  shop: string,
  accessToken: string,
  params: {
    amount: string;
    customerId: string | null;
    note: string;
    message?: string;
  },
): Promise<GiftCardResult> {
  const baseInput: Record<string, unknown> = {
    initialValue: params.amount,
    note: params.note,
  };
  if (params.customerId) {
    baseInput.customerId = params.customerId;
  }

  const withRecipient = params.customerId
    ? {
        ...baseInput,
        recipientAttributes: {
          recipient: params.customerId,
          ...(params.message ? { message: params.message } : {}),
        },
      }
    : baseInput;

  const attempts: { input: Record<string, unknown>; notified: boolean }[] =
    params.customerId
      ? [
          { input: withRecipient, notified: true },
          { input: baseInput, notified: false },
        ]
      : [{ input: baseInput, notified: false }];

  let lastError = "unknown error";

  for (const attempt of attempts) {
    let data: GiftCardData;
    try {
      data = await adminGraphql<GiftCardData>(
        shop,
        accessToken,
        GIFT_CARD_CREATE_MUTATION,
        { input: attempt.input },
        "create gift card",
      );
    } catch (err) {
      // A thrown error is AMBIGUOUS: the request may have timed out or the
      // socket dropped *after* Shopify created the card. Retrying would mint a
      // second one for the same overpayment. Bail and let the merchant refund
      // manually — under-issuing is recoverable, double-issuing is not.
      lastError = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Gift card could not be created and it is unclear whether Shopify created ` +
          `one (${lastError}). Check Shopify Admin → Gift cards before refunding manually.`,
      );
    }

    const errs = data.giftCardCreate?.userErrors ?? [];
    if (errs.length) {
      // A userErrors response is DEFINITIVE — Shopify validated and refused, so
      // nothing was created and retrying without recipientAttributes is safe.
      lastError = errs.map((e) => e.message).join("; ");
      console.warn(
        `[payram-admin] giftCardCreate rejected (notified=${attempt.notified}):`,
        lastError,
      );
      continue;
    }

    const card = data.giftCardCreate?.giftCard;
    if (!card?.id) {
      lastError = "Shopify returned no gift card";
      continue;
    }

    return {
      id: card.id,
      lastCharacters: card.lastCharacters ?? null,
      amount: card.balance?.amount ?? params.amount,
      currencyCode: card.balance?.currencyCode ?? null,
      notified: attempt.notified,
    };
  }

  throw new Error(`Gift card could not be created: ${lastError}`);
}
