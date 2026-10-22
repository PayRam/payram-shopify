import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "APP_UNINSTALLED":
      if (session) {
        await prisma.session.deleteMany({ where: { shop } });
      }
      break;

    // The merchant approved (or revoked) access scopes in Shopify Admin.
    //
    // Under token exchange nothing else refreshes the stored scope: the offline
    // token keeps working with the new grant, and the library never re-exchanges
    // an active session. The settings page decides whether overpayment gift
    // cards can be issued from `session.scope`, so without this it would keep
    // saying "permission not granted" after the merchant had granted it. (The
    // Remix auth-code flow re-ran OAuth on a scope change, which rewrote it.)
    case "APP_SCOPES_UPDATE": {
      const current = (payload as { current?: unknown } | undefined)?.current;
      if (session && Array.isArray(current)) {
        await prisma.session.update({
          where: { id: session.id },
          data: { scope: current.map(String).join(",") },
        });
      }
      break;
    }

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
