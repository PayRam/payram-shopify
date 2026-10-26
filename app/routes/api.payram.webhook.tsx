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
 * orphaned funds count towards the order they were meant for — once Payram
 * confirms the reference really is that order's. `customer_id` is printed in
 * the buyer's own payment link, so it only ever picks which order to ask about.
 *
 * TRUST — NOTHING IN THE BODY IS BELIEVED
 * --------------------------------------
 * `customer_id` is printed in the buyer's own payment link, and Payram before
 * 3.9.0 does not sign its webhooks, so a buyer can post one of these. The body
 * therefore only says WHICH reference to ask about:
 *
 *  1. Signature (MF-013). Once this shop has received a webhook correctly
 *     signed with its saved API key, unsigned or wrongly signed ones are
 *     refused (401) before anything is read or written.
 *  2. Confirmation (MF-012). Every reference is looked up with Payram, and only
 *     if Payram confirms it belongs to this order are PAYRAM's figures — never
 *     the body's — recorded and settled. Otherwise nothing is recorded: no
 *     money row, no tag, no note, no paid status, no gift card. The merchant
 *     gets a plain-words syncError saying what happened and what to do.
 *
 * Response codes are the contract with payram-core, which re-sends anything
 * that is not 2xx (pkg/utils/utils.go → SendWebhookToMerchant treats status
 * >= 400 as failure; payment_service_impl.go retries three times at once, then
 * on the delivery-log schedule of 30 min up to 48 h):
 *   200  handled, or deliberately ignored — Payram's answer is final
 *   401  refused by the signature check — Payram retries; succeeds once the
 *        right key is saved
 *   503  Payram could not be asked — Payram retries
 *   500  settlement itself failed (Shopify) — Payram retries
 */
import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { findOfflineAccessToken } from "~/utils/shopify-admin.server";
import { authenticateWebhook } from "~/utils/payram.server";
import {
  confirmPayramReference,
  normalizePayramState,
  recordConfirmedPayment,
  settleOrder,
} from "~/utils/settlement.server";

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
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // The signature covers the exact bytes Payram sent, so keep them.
  const rawBody = new Uint8Array(await request.arrayBuffer());
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    // JSON.parse accepts `null`, `1` and `"x"`, all of which would throw on the
    // property reads below and turn into a 500 that Payram retries.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
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
  // Logged for diagnosis only. Never recorded, never settled on.
  const claimedFilledUsd =
    decimalString(body.filled_amount_in_usd) ??
    decimalString((body as Record<string, unknown>).filledAmountInUSD);
  const txHash = firstTxHash(body.payment_info ?? body.paymentInfo);

  if (!referenceId) {
    return Response.json(
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
    return Response.json({ ok: true, note: "no matching order, ignoring" });
  }

  // --- 1. Signature ---
  const auth = await authenticateWebhook(mapping.shop, rawBody, request.headers);
  if (auth.outcome === "refused") {
    console.error(
      `[payram-webhook] refused reference=${referenceId} for ${mapping.shop}: ${auth.message}`,
    );
    return Response.json({ error: auth.message }, { status: 401 });
  }

  console.info("[payram-webhook] received", {
    shopifyOrderId: mapping.shopifyOrderId,
    referenceId,
    claimedState: state,
    claimedFilledUsd,
    viaCustomerId,
    signed: auth.outcome === "signed",
  });

  // An unrecognised status must never settle an order. `normalizePayramState`
  // maps anything it does not know — including a missing `status` — to
  // UNDEFINED, and the body is untrusted, so a body with no status at all must
  // not be able to tag an order paid.
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
    return Response.json({ ok: true, note: "unrecognised status, ignored" });
  }

  // --- 2. Confirm with Payram before anything is recorded ---
  const confirmation = await confirmPayramReference(
    mapping.shop,
    mapping.shopifyOrderId,
    referenceId,
  );

  if (confirmation.outcome === "unavailable") {
    console.warn(
      `[payram-webhook] could not confirm reference=${referenceId} with Payram ` +
        `(${confirmation.reason}); nothing recorded, asking Payram to resend`,
    );
    await noteOnMapping(
      mapping.id,
      // The reason is one of payram.server.ts's fixed phrases ("Payram could
      // not be reached", "no Payram server is configured", "Payram answered
      // HTTP 502"…) — never a raw network error, which could name internal
      // hosts on the unauthenticated status endpoint (MF-007).
      `A payment message for this order could not be confirmed with Payram (${confirmation.reason}), ` +
        "so nothing was changed. Payram will send it again. Check the Payram Base URL and API " +
        "Key in this app's settings; if the order still looks wrong later, use Re-check payment.",
    );
    // 503: payram-core re-sends any non-2xx, and this answer can change.
    return Response.json(
      { error: "Payram could not be reached to confirm this payment. Send it again later." },
      { status: 503 },
    );
  }

  if (confirmation.outcome === "rejected") {
    console.warn(
      `[payram-webhook] reference=${referenceId} not confirmed by Payram for ` +
        `${mapping.shop} order ${mapping.shopifyOrderId} ` +
        `(${confirmation.reason === "other_order" ? `belongs to ${String(confirmation.ownerCustomerId)}` : "no such payment"}); ` +
        `it claimed ${String(rawStatus)} ${String(claimedFilledUsd)} USD — ignored, nothing recorded`,
    );
    await noteOnMapping(
      mapping.id,
      confirmation.reason === "other_order"
        ? "A payment message for this order named a Payram payment that belongs to a " +
            "different order. It could not be confirmed with Payram and was ignored. If the " +
            "customer paid, use Re-check payment."
        : "A payment message for this order could not be confirmed with Payram and was " +
            "ignored. If the customer paid, use Re-check payment.",
    );
    // 200: Payram has answered; resending the same message cannot change that.
    return Response.json({ ok: true, note: "not confirmed by Payram, ignored" });
  }

  // From here on, every figure is Payram's.
  const confirmedState = confirmation.state;

  if (confirmedState === "UNDEFINED") {
    await noteOnMapping(
      mapping.id,
      "Payram reported a payment status this app does not recognise for this order. " +
        "The order was left untouched — check this payment in Payram.",
    );
    return Response.json({ ok: true, note: "unrecognised status, ignored" });
  }

  // Nothing has arrived, or the request was voided. Record it against the
  // reference so a cancelled request stops counting toward the order's total,
  // then leave the Shopify order alone. Payram's word, so it is a confirmed row.
  if (confirmedState === "OPEN" || confirmedState === "CANCELLED") {
    await prisma.$transaction(async (tx) => {
      await recordConfirmedPayment(tx, {
        shop: mapping.shop,
        shopifyOrderId: mapping.shopifyOrderId,
        referenceId,
        state: confirmedState,
        filledAmountInUsd: null,
        txHash,
      });
      await tx.paymentMapping.update({
        where: { id: mapping.id },
        data: { payramStatus: confirmedState, lastSyncAt: new Date() },
      });
    });
    return Response.json({ ok: true, state: confirmedState });
  }

  const accessToken = await findOfflineAccessToken(mapping.shop);
  if (!accessToken) {
    await prisma.paymentMapping.update({
      where: { id: mapping.id },
      data: {
        payramStatus: confirmedState,
        syncError:
          "No offline session for shop — reopen the Payram app in Shopify Admin to reconnect it.",
        lastSyncAt: new Date(),
      },
    });
    // 200: reinstalling is a merchant action; retrying will not fix it.
    return Response.json({ ok: true, note: "shop not connected" });
  }

  try {
    const outcome = await settleOrder({
      shop: mapping.shop,
      shopifyOrderId: mapping.shopifyOrderId,
      referenceId,
      state: confirmedState,
      filledAmountInUsd: confirmation.filledAmountInUsd,
      txHash,
      accessToken,
      // Payram confirmed the reference exists and is this order's.
      verified: true,
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

    return Response.json({
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
    return Response.json({ error: "Settlement failed" }, { status: 500 });
  }
};

/** Tell the merchant, on the order, what happened to a message. Not money. */
async function noteOnMapping(mappingId: string, syncError: string): Promise<void> {
  await prisma.paymentMapping.update({
    where: { id: mappingId },
    data: { syncError, lastSyncAt: new Date() },
  });
}
