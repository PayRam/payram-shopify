/**
 * POST /api/payram/webhook
 *
 * Receives Payram payment status webhooks.
 * Resolves the PaymentMapping by referenceId, updates status,
 * and tags the Shopify order when the external payment completes.
 *
 * The Shopify sync is fault-tolerant: sync failures are stored in syncError
 * and do not cause the webhook to return 5xx (which would trigger Payram
 * retries for a known-permanent failure).
 *
 * TODO: Add webhook signature verification when Payram publishes their
 * signing mechanism (e.g., HMAC header). Until then, referenceId acts as
 * an unguessable identifier.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "~/db.server";
import { sessionStorage } from "~/shopify.server";
import { tagShopifyOrderPaid } from "~/utils/shopify-admin.server";

// Payram statuses that represent a successfully completed payment
const PAID_STATUSES = new Set(["paid", "confirmed", "closed", "completed"]);

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

  // Accept common field name variants from Payram's webhook payload
  const referenceId = (
    (body.referenceId ?? body.reference_id ?? body.paymentId) as
      | string
      | undefined
  )?.trim();
  const status = (
    (body.status ?? body.paymentStatus) as string | undefined
  )?.trim();

  if (!referenceId) {
    return json(
      { error: "Missing referenceId in webhook payload" },
      { status: 400 }
    );
  }

  const mapping = await prisma.paymentMapping.findFirst({
    where: { payramReferenceId: referenceId },
  });

  if (!mapping) {
    // Return 200 so Payram does not retry indefinitely for unknown references
    console.warn(
      `[payram-webhook] No mapping found for referenceId=${referenceId}`
    );
    return json({ ok: true, note: "mapping not found, ignoring" });
  }

  // Update Payram payment status
  await prisma.paymentMapping.update({
    where: { id: mapping.id },
    data: {
      payramStatus: status ?? mapping.payramStatus,
      lastSyncAt: new Date(),
    },
  });

  // If payment is complete, tag the Shopify order for merchant reconciliation.
  if (status && PAID_STATUSES.has(status.toLowerCase())) {
    await attemptTagShopifyOrderPaid(
      mapping.shop,
      mapping.shopifyOrderId,
      mapping.id
    );
  }

  return json({ ok: true });
};

async function attemptTagShopifyOrderPaid(
  shop: string,
  shopifyOrderId: string,
  mappingId: string
): Promise<void> {
  try {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    // Use the offline (persistent) session — online sessions are user-scoped
    const offlineSession = sessions.find((s) => !s.isOnline && s.accessToken);

    if (!offlineSession?.accessToken) {
      await prisma.paymentMapping.update({
        where: { id: mappingId },
        data: {
          syncError:
            "No offline session for shop — re-install the app to grant offline access.",
          lastSyncAt: new Date(),
        },
      });
      return;
    }

    await tagShopifyOrderPaid(
      shop,
      offlineSession.accessToken,
      shopifyOrderId,
      mappingId
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[payram-webhook] Unexpected error in tagShopifyOrderPaid:", msg);
    await prisma.paymentMapping.update({
      where: { id: mappingId },
      data: { syncError: msg, lastSyncAt: new Date() },
    });
  }
}
