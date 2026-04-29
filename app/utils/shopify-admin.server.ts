/**
 * Calls Shopify Admin GraphQL orderMarkAsPaid mutation.
 *
 * NOTE: This is PCD-gated (Protected Customer Data) and will fail in
 * development stores until the app passes Shopify public app review.
 * Errors are stored in PaymentMapping.syncError and do not block webhook
 * acknowledgement.
 */
import prisma from "~/db.server";

const SHOPIFY_API_VERSION = "2025-01";

const ORDER_MARK_AS_PAID_MUTATION = /* graphql */ `
  mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order {
        id
        displayFinancialStatus
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface MarkPaidResult {
  ok: boolean;
  financialStatus?: string;
  error?: string;
}

export async function markShopifyOrderPaid(
  shop: string,
  accessToken: string,
  shopifyOrderId: string,
  mappingId: string
): Promise<MarkPaidResult> {
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
          query: ORDER_MARK_AS_PAID_MUTATION,
          variables: { input: { id: gid } },
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
      orderMarkAsPaid?: {
        order?: { id: string; displayFinancialStatus: string };
        userErrors?: { field: string; message: string }[];
      };
    };
    errors?: unknown;
  };

  const userErrors = json.data?.orderMarkAsPaid?.userErrors ?? [];
  if (userErrors.length > 0) {
    const msg = userErrors.map((e) => e.message).join("; ");
    await prisma.paymentMapping.update({
      where: { id: mappingId },
      data: { syncError: msg, lastSyncAt: new Date() },
    });
    return { ok: false, error: msg };
  }

  const order = json.data?.orderMarkAsPaid?.order;
  if (order) {
    await prisma.paymentMapping.update({
      where: { id: mappingId },
      data: {
        shopifyFinancialStatus: order.displayFinancialStatus,
        shopifyPaidSyncedAt: new Date(),
        lastSyncAt: new Date(),
        syncError: null,
      },
    });
    return { ok: true, financialStatus: order.displayFinancialStatus };
  }

  return { ok: false, error: "No order data in response" };
}
