/**
 * GET /api/payram/status
 *
 * Returns the current PaymentMapping for an order or Payram reference.
 *
 * Query params (at least one required):
 *   shopifyOrderId    + shop  — look up by order
 *   payramReferenceId         — look up by Payram reference
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopifyOrderId = url.searchParams.get("shopifyOrderId") ?? undefined;
  const payramReferenceId =
    url.searchParams.get("payramReferenceId") ?? undefined;
  const shop = url.searchParams.get("shop") ?? undefined;

  if (!shopifyOrderId && !payramReferenceId) {
    return json(
      { error: "Provide shopifyOrderId (+ shop) or payramReferenceId" },
      { status: 400 }
    );
  }

  let mapping = null;

  if (shopifyOrderId && shop) {
    mapping = await prisma.paymentMapping.findUnique({
      where: { shop_shopifyOrderId: { shop, shopifyOrderId } },
    });
  } else if (payramReferenceId) {
    mapping = await prisma.paymentMapping.findFirst({
      where: { payramReferenceId },
    });
  }

  if (!mapping) {
    return json({ error: "Mapping not found" }, { status: 404 });
  }

  // Do not expose the checkout URL in status responses (it is a direct
  // payment link). Return all other non-sensitive fields.
  return json({
    shop: mapping.shop,
    shopifyOrderId: mapping.shopifyOrderId,
    shopifyOrderName: mapping.shopifyOrderName,
    payramReferenceId: mapping.payramReferenceId,
    payramStatus: mapping.payramStatus,
    shopifyFinancialStatus: mapping.shopifyFinancialStatus,
    shopifyPaidSyncedAt: mapping.shopifyPaidSyncedAt,
    lastSyncAt: mapping.lastSyncAt,
    syncError: mapping.syncError,
    createdAt: mapping.createdAt,
    updatedAt: mapping.updatedAt,
  });
};
