/**
 * POST /api/payram/webhook
 *
 * Receives Payram payment webhooks and settles the Shopify order.
 *
 * PAYLOAD (payram-core, pkg/utils/utils.go → SendWebhookToMerchant):
 *   {
 *     "customer_id":          "shopify:{shop}:order:{orderId}",
 *     "invoice_id":           "...",
 *     "reference_id":         "...",
 *     "status":               "OPEN" | "FILLED" | "PARTIALLY_FILLED" | "OVER_FILLED" | "CANCELLED",
 *     "amount":               "...",
 *     "currency":             "USDT",
 *     "filled_amount":        "...",
 *     "filled_amount_in_usd": "40.00",
 *     "payment_info":         [{ "transaction_hash": "...", "destination_address": "..." }],
 *     "confirmation_current": 3,
 *     "confirmation_required": 12
 *   }
 *
 * Two things this route used to get wrong:
 *
 *  1. It compared `status` against ["paid","confirmed","closed","completed"].
 *     Payram sends none of those, so no order was ever tagged paid.
 *  2. It treated payment as binary. Payram distinguishes PARTIALLY_FILLED and
 *     OVER_FILLED, and both were being handled as "not paid" / "paid".
 *
 * TOP-UPS AND ORPHAN PAYMENTS
 * ---------------------------
 * When a buyer sends more crypto after underpaying, payram-core creates a NEW
 * payment request with a NEW reference_id rather than topping up the original.
 * Those webhooks carry a reference this connector has never seen — but the same
 * `customer_id`, because the member is unchanged. So when a reference is unknown
 * we fall back to resolving the order from `customer_id`, which lets otherwise
 * orphaned funds count towards the order they were meant for.
 *
 * TODO: Add webhook signature verification when Payram publishes a signing
 * mechanism (see state/malicious-flows.md, MF-004). Until then referenceId acts
 * as an unguessable identifier.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "~/db.server";
import { findOfflineAccessToken } from "~/utils/shopify-admin.server";
import { fetchPayramPayment } from "~/utils/payram.server";
import { normalizePayramState, settleOrder } from "~/utils/settlement.server";

/**
 * Parse `shopify:{shop}:order:{orderId}`.
 *
 * The shop domain contains dots but never colons, so positional splitting is safe.
 */
export function parsePayramCustomerId(
  raw: unknown,
): { shop: string; shopifyOrderId: string } | null {
  const parts = String(raw ?? "").split(":");
  if (parts.length < 4) return null;
  const [prefix, shop, keyword, orderId] = parts;
  if (prefix !== "shopify" || keyword !== "order") return null;
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return null;
  if (!/^\d+$/.test(orderId) || orderId === "0") return null;
  return { shop, shopifyOrderId: orderId };
}

function firstTxHash(paymentInfo: unknown): string | null {
  if (!Array.isArray(paymentInfo) || paymentInfo.length === 0) return null;
  const entry = paymentInfo[0] as Record<string, unknown> | undefined;
  const hash = entry?.transaction_hash ?? entry?.transactionHash;
  return typeof hash === "string" && hash ? hash : null;
}

/**
 * Parse a money field from the webhook.
 *
 * Non-negative only. A negative `filled_amount_in_usd` would subtract from an
 * order's received total, flipping a fully paid order back to "underpaid" — and
 * the webhook is unsigned, so the value is attacker-supplied.
 */
function decimalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s && /^\d+(\.\d+)?$/.test(s) ? s : null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Accept both Payram's snake_case webhook fields and camelCase variants.
  // The cast is not a runtime check and the body is untrusted: a numeric
  // reference_id would throw on .trim() and 500, which Payram then retries.
  const rawReference = body.reference_id ?? body.referenceId ?? body.paymentId;
  const referenceId =
    typeof rawReference === "string" || typeof rawReference === "number"
      ? String(rawReference).trim()
      : "";
  const rawStatus = body.status ?? body.paymentStatus;
  const state = normalizePayramState(rawStatus);
  const filledAmountInUsd =
    decimalString(body.filled_amount_in_usd) ??
    decimalString((body as Record<string, unknown>).filledAmountInUSD);
  const txHash = firstTxHash(body.payment_info ?? body.paymentInfo);

  if (!referenceId) {
    return json(
      { error: "Missing reference_id in webhook payload" },
      { status: 400 },
    );
  }

  // --- Resolve the order ---
  // Primary: the reference we created. Fallback: customer_id, which catches
  // top-up payments that arrive under a brand-new Payram reference.
  let mapping = await prisma.paymentMapping.findFirst({
    where: { payramReferenceId: referenceId },
  });

  let viaCustomerId = false;
  if (!mapping) {
    const parsed = parsePayramCustomerId(body.customer_id ?? body.customerId);
    if (parsed) {
      mapping = await prisma.paymentMapping.findUnique({
        where: {
          shop_shopifyOrderId: {
            shop: parsed.shop,
            shopifyOrderId: parsed.shopifyOrderId,
          },
        },
      });
      viaCustomerId = Boolean(mapping);
    }
  }

  if (!mapping) {
    // 200 so Payram stops retrying a reference that belongs to another system.
    console.warn(
      `[payram-webhook] no order for reference=${referenceId} customer_id=${String(
        body.customer_id ?? "",
      )}`,
    );
    return json({ ok: true, note: "no matching order, ignoring" });
  }

  console.info("[payram-webhook] settling", {
    shopifyOrderId: mapping.shopifyOrderId,
    referenceId,
    state,
    filledAmountInUsd,
    viaCustomerId,
  });

  // An unrecognised status must never settle an order. `normalizePayramState`
  // maps anything it does not know — including a missing `status` — to
  // UNDEFINED, and this webhook is unsigned, so a body with no status at all
  // must not be able to tag an order paid.
  if (state === "UNDEFINED") {
    console.warn(
      `[payram-webhook] unrecognised status ${String(rawStatus)} for reference=${referenceId}`,
    );
    await prisma.paymentMapping.update({
      where: { id: mapping.id },
      data: {
        syncError:
          `Payram sent an unrecognised payment status (${String(rawStatus)}). ` +
          "The order was left untouched — check this payment in Payram.",
        lastSyncAt: new Date(),
      },
    });
    return json({ ok: true, note: "unrecognised status, ignored" });
  }

  // Nothing has arrived, or the request was voided. Record it against the
  // reference so a cancelled request stops counting toward the order's total,
  // then leave the Shopify order alone.
  if (state === "OPEN" || state === "CANCELLED") {
    await prisma.payramPayment.upsert({
      where: { payramReferenceId: referenceId },
      create: {
        shop: mapping.shop,
        shopifyOrderId: mapping.shopifyOrderId,
        payramReferenceId: referenceId,
        state,
        // Neither state has delivered funds: OPEN means nothing has arrived yet,
        // CANCELLED means it never will. Storing the body's amount here would let
        // an unsigned webhook credit an order with money that does not exist,
        // because the received total only excludes CANCELLED.
        filledAmountInUsd: null,
        txHash,
      },
      update: {
        state,
        filledAmountInUsd: null,
        updatedAt: new Date(),
      },
    });
    await prisma.paymentMapping.update({
      where: { id: mapping.id },
      data: { payramStatus: state, lastSyncAt: new Date() },
    });
    return json({ ok: true, state });
  }

  const accessToken = await findOfflineAccessToken(mapping.shop);
  if (!accessToken) {
    await prisma.paymentMapping.update({
      where: { id: mapping.id },
      data: {
        payramStatus: state,
        syncError:
          "No offline session for shop — reopen the Payram app in Shopify Admin to reconnect it.",
        lastSyncAt: new Date(),
      },
    });
    // 200: reinstalling is a merchant action; retrying will not fix it.
    return json({ ok: true, note: "shop not connected" });
  }

  // --- Re-verify with Payram before acting ---
  // The webhook is unsigned, so its amounts cannot be trusted for anything that
  // moves money. Ask Payram directly; the webhook body is used for recording
  // only, never for issuing a gift card.
  const snapshot = await fetchPayramPayment(mapping.shop, referenceId);

  // Verifying that the reference exists is not enough — it must also be THIS
  // order's money. Without this, a reference belonging to order A could be
  // posted with order B's customer_id and have its funds (and any resulting
  // gift card) credited to B.
  const expectedCustomerId = `shopify:${mapping.shop}:order:${mapping.shopifyOrderId}`;
  const ownsOrder =
    snapshot?.customerId != null &&
    (snapshot.customerId === expectedCustomerId ||
      // Top-ups are issued under a suffixed customerId for the same order.
      snapshot.customerId.startsWith(`${expectedCustomerId}:`));

  if (snapshot && !ownsOrder) {
    console.error(
      `[payram-webhook] reference=${referenceId} belongs to ${String(
        snapshot.customerId,
      )}, not ${expectedCustomerId} — refusing to settle`,
    );
    await prisma.paymentMapping.update({
      where: { id: mapping.id },
      data: {
        syncError:
          "A payment webhook referenced a Payram payment belonging to a different " +
          "order. It was ignored. Check this order against Payram.",
        lastSyncAt: new Date(),
      },
    });
    return json({ ok: true, note: "reference does not belong to this order" });
  }

  const verified = ownsOrder;
  const effectiveState = snapshot?.paymentState
    ? normalizePayramState(snapshot.paymentState)
    : state;
  const effectiveFilled = snapshot?.filledAmountInUsd ?? filledAmountInUsd;

  if (!verified) {
    console.warn(
      `[payram-webhook] could not verify reference=${referenceId} with Payram; ` +
        "recording from webhook body only",
    );
  }

  try {
    const outcome = await settleOrder({
      shop: mapping.shop,
      shopifyOrderId: mapping.shopifyOrderId,
      referenceId,
      state: effectiveState,
      filledAmountInUsd: effectiveFilled,
      txHash,
      accessToken,
      verified,
    });

    console.info("[payram-webhook] settled", {
      shopifyOrderId: mapping.shopifyOrderId,
      received: outcome.receivedUsd,
      invoiced: outcome.invoicedUsd,
      balance: outcome.balanceUsd,
      settled: outcome.settled,
      giftCardIssued: outcome.giftCardIssued,
      warnings: outcome.warnings,
    });

    return json({
      ok: true,
      state: outcome.state,
      settled: outcome.settled,
      balanceUsd: outcome.balanceUsd,
      giftCardIssued: outcome.giftCardIssued,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[payram-webhook] settlement failed:", msg);
    await prisma.paymentMapping
      .update({
        where: { id: mapping.id },
        data: { syncError: msg, lastSyncAt: new Date() },
      })
      .catch(() => {});
    // 500 so Payram retries — this is likely transient (network, Shopify 5xx).
    return json({ error: "Settlement failed" }, { status: 500 });
  }
};
