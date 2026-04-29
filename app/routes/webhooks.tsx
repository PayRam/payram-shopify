import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session } = await authenticate.webhook(request);

  switch (topic) {
    case "APP_UNINSTALLED":
      if (session) {
        await prisma.session.deleteMany({ where: { shop } });
      }
      break;

    // GDPR mandatory webhooks — implement data handling before app store submission
    case "CUSTOMERS_DATA_REQUEST":
      // TODO: Respond with customer data held for the shop (PaymentMapping rows)
      break;
    case "CUSTOMERS_REDACT":
      // TODO: Delete/anonymise customer data (email fields) for the given customer
      break;
    case "SHOP_REDACT":
      // TODO: Delete all data for the shop after uninstall + 48 h grace period
      await prisma.paymentMapping.deleteMany({ where: { shop } });
      await prisma.merchantConfig.deleteMany({ where: { shop } });
      break;

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response(null, { status: 200 });
};
