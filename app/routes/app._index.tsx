import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { decrypt, encrypt } from "~/utils/encryption.server";
import { validatePayramBaseUrl } from "~/utils/payram.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const config = await prisma.merchantConfig.findUnique({
    where: { shop: session.shop },
  });
  return json({
    shop: session.shop,
    payramBaseUrl: config?.payramBaseUrl ?? "",
    paymentMethodName:
      config?.paymentMethodName ?? "Pay with Crypto via Payram",
    hasApiKey: !!config?.payramProjectApiKeyEncrypted,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");
  const payramBaseUrl = String(formData.get("payramBaseUrl") ?? "").trim();
  const payramProjectApiKey = String(
    formData.get("payramProjectApiKey") ?? ""
  ).trim();
  const paymentMethodName = String(
    formData.get("paymentMethodName") ?? "Pay with Crypto via Payram"
  ).trim();

  // --- Test connection ---
  if (intent === "test") {
    if (!payramBaseUrl) {
      return json({ error: "Enter a Payram Base URL to test." });
    }
    try {
      validatePayramBaseUrl(payramBaseUrl);
    } catch (err) {
      return json({
        error: err instanceof Error ? err.message : "Invalid URL",
      });
    }

    // Resolve API key: prefer form input, fall back to stored key
    let apiKey = payramProjectApiKey;
    if (!apiKey) {
      const existing = await prisma.merchantConfig.findUnique({
        where: { shop: session.shop },
      });
      if (!existing?.payramProjectApiKeyEncrypted) {
        return json({ error: "No API key saved yet. Enter one above." });
      }
      apiKey = decrypt(existing.payramProjectApiKeyEncrypted);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(
        `${payramBaseUrl.replace(/\/$/, "")}/api/v1/payment`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "API-Key": apiKey,
          },
          body: JSON.stringify({
            customerId: "shopify:test:order:0",
            amountInUSD: 0.01,
          }),
          signal: controller.signal,
        }
      ).finally(() => clearTimeout(timeoutId));

      // 2xx or 4xx both mean the server is reachable
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return json({
          success: `Payram API reachable — HTTP ${res.status}`,
        });
      }
      return json({ error: `Payram API returned HTTP ${res.status}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: `Connection failed: ${msg}` });
    }
  }

  // --- Save settings ---
  if (!payramBaseUrl) {
    return json({ error: "Payram Base URL is required." });
  }
  try {
    validatePayramBaseUrl(payramBaseUrl);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Invalid URL" });
  }

  const existing = await prisma.merchantConfig.findUnique({
    where: { shop: session.shop },
  });

  let encryptedKey = existing?.payramProjectApiKeyEncrypted ?? "";
  if (payramProjectApiKey) {
    encryptedKey = encrypt(payramProjectApiKey);
  }
  if (!encryptedKey) {
    return json({ error: "Payram Project API Key is required." });
  }

  await prisma.merchantConfig.upsert({
    where: { shop: session.shop },
    create: {
      shop: session.shop,
      payramBaseUrl,
      payramProjectApiKeyEncrypted: encryptedKey,
      paymentMethodName,
    },
    update: {
      payramBaseUrl,
      payramProjectApiKeyEncrypted: encryptedKey,
      paymentMethodName,
    },
  });

  return json({ success: "Settings saved." });
};

export default function SettingsPage() {
  const { payramBaseUrl, paymentMethodName, hasApiKey } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [baseUrl, setBaseUrl] = useState(payramBaseUrl);
  const [methodName, setMethodName] = useState(paymentMethodName);

  return (
    <Page title="Payram Connector Settings">
      <Layout>
        <Layout.Section>
          {actionData && 'error' in actionData && (
            <Banner tone="critical" title="Error">
              <p>{actionData.error}</p>
            </Banner>
          )}
          {actionData && 'success' in actionData && (
            <Banner tone="success" title="Success">
              <p>{actionData.success}</p>
            </Banner>
          )}
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Payram API Credentials
              </Text>
              <Form method="post">
                <input type="hidden" name="intent" value="save" />
                <FormLayout>
                  <TextField
                    label="Payram Base URL"
                    name="payramBaseUrl"
                    value={baseUrl}
                    onChange={setBaseUrl}
                    placeholder="https://your-payram-instance.com"
                    autoComplete="off"
                    helpText="Base URL of your Payram instance. Must be HTTPS."
                  />
                  <TextField
                    label="Payram Project API Key"
                    name="payramProjectApiKey"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      hasApiKey ? "•••••••••••••• (saved)" : "Enter API Key"
                    }
                    helpText="Leave blank to keep the existing saved key."
                  />
                  <TextField
                    label="Payment Method Name"
                    name="paymentMethodName"
                    value={methodName}
                    onChange={setMethodName}
                    autoComplete="off"
                    helpText='Label shown to buyers. Default: "Pay with Crypto via Payram"'
                  />
                  <Button submit loading={isSubmitting} variant="primary">
                    Save Settings
                  </Button>
                </FormLayout>
              </Form>

              <Form method="post">
                <input type="hidden" name="intent" value="test" />
                <input type="hidden" name="payramBaseUrl" value={baseUrl} />
                <Button submit loading={isSubmitting} variant="plain">
                  Test Payram Connection
                </Button>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
