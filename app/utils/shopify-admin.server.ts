/**
 * Syncs an external Payram payment back into Shopify by tagging the order.
 *
 * This avoids the PCD-gated orderMarkAsPaid mutation while still giving
 * merchants a visible signal in Shopify Admin that the external payment
 * completed successfully.
 */
import prisma from "~/db.server";

const SHOPIFY_API_VERSION = "2025-01";
const PAYRAM_PAID_TAG = "payram_paid";

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
