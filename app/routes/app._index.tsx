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

function summarizeResponseText(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 160
    ? `${normalized.slice(0, 157)}...`
    : normalized;
}

function getCheckoutUrl(payload: Record<string, unknown>): string | null {
  const checkoutUrl =
    (payload.checkoutUrl as string | undefined) ??
    (payload.checkout_url as string | undefined) ??
    (payload.paymentUrl as string | undefined) ??
    (payload.url as string | undefined);

  return checkoutUrl ?? null;
}

function getReferenceId(payload: Record<string, unknown>): string | null {
  const referenceId =
    (payload.referenceId as string | undefined) ??
    (payload.reference_id as string | undefined) ??
    (payload.id as string | undefined);

  return referenceId ?? null;
}

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

  // --- Test Payram server reachability ---
  if (intent === "test-server") {
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

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(payramBaseUrl.replace(/\/$/, ""), {
        method: "GET",
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));
      const responseText = await res.text().catch(() => "");
      const summary = summarizeResponseText(responseText);

      if (res.ok) {
        const payramCoreDetected = /welcome to payram core/i.test(responseText);
        return json({
          success: payramCoreDetected
            ? `Payram server reachable — HTTP ${res.status}. Payram Core responded normally.`
            : `Payram server reachable — HTTP ${res.status}${summary ? `. Response: ${summary}` : ""}`,
        });
      }

      return json({
        error: `Payram server returned HTTP ${res.status}${summary ? `: ${summary}` : "."}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: `Connection failed: ${msg}` });
    }
  }

  // --- Test Payram payment API / API key ---
  if (intent === "test-payment-api") {
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
            customerEmail: "shopify-payram-test@example.com",
            customerId: `shopify:test:${session.shop}`,
            amountInUSD: 50,
          }),
          signal: controller.signal,
        }
      ).finally(() => clearTimeout(timeoutId));
      const responseText = await res.text().catch(() => "");
      const summary = summarizeResponseText(responseText);

      if (res.ok) {
        let payload: Record<string, unknown> = {};
        if (responseText) {
          try {
            payload = JSON.parse(responseText) as Record<string, unknown>;
          } catch {
            return json({
              error: `Payram payment API returned HTTP ${res.status} but did not return valid JSON.`,
            });
          }
        }

        const checkoutUrl = getCheckoutUrl(payload);
        const referenceId = getReferenceId(payload);

        if (!checkoutUrl) {
          return json({
            error:
              `Payram payment API returned HTTP ${res.status} but did not include a checkout URL.`,
          });
        }

        return json({
          success: `Test payment link created successfully — HTTP ${res.status}${referenceId ? ` (${referenceId})` : ""}`,
          checkoutUrl,
        });
      }

      return json({
        error:
          `Payram payment API returned HTTP ${res.status}` +
          `${summary ? `: ${summary}` : "."}`,
      });
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
  const [apiKey, setApiKey] = useState("");

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
              {'checkoutUrl' in actionData && actionData.checkoutUrl ? (
                <p>
                  <a
                    href={actionData.checkoutUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open the test payment link
                  </a>
                </p>
              ) : null}
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
                    value={apiKey}
                    onChange={setApiKey}
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

              <Text as="p" variant="bodySm" tone="subdued">
                Test the server separately from the payment API. The server test
                checks that the base URL responds with HTTP 2xx. The payment API
                test creates a real test payment link using the current API key.
              </Text>

              <Form method="post">
                <input type="hidden" name="intent" value="test-server" />
                <input type="hidden" name="payramBaseUrl" value={baseUrl} />
                <Button submit loading={isSubmitting} variant="plain">
                  Test Payram Server
                </Button>
              </Form>

              <Form method="post">
                <input type="hidden" name="intent" value="test-payment-api" />
                <input type="hidden" name="payramBaseUrl" value={baseUrl} />
                <input
                  type="hidden"
                  name="payramProjectApiKey"
                  value={apiKey}
                />
                <Button submit loading={isSubmitting} variant="plain">
                  Create Test Payment Link
                </Button>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
