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
  Checkbox,
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

  // Recent payment activity, so problems the connector recorded during a webhook
  // are visible here instead of only in server logs.
  const payments = await prisma.paymentMapping.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });
  const needsAttention = await prisma.paymentMapping.count({
    where: {
      shop: session.shop,
      OR: [
        { syncError: { not: null } },
        { shopifyFinancialStatus: "payram_partially_paid" },
      ],
    },
  });

  // Gift card refunds need a scope that existing installs were not granted.
  const grantedScopes = (session.scope ?? "").split(",").map((x) => x.trim());
  const hasGiftCardScope = grantedScopes.includes("write_gift_cards");

  return json({
    shop: session.shop,
    needsAttention,
    hasGiftCardScope,
    payments: payments.map((p) => ({
      shopifyOrderId: p.shopifyOrderId,
      orderName: p.shopifyOrderName,
      state: p.paymentState ?? p.payramStatus ?? "—",
      currency: p.orderCurrency,
      orderAmount: p.orderAmount,
      invoicedUsd: p.amountInUsd,
      receivedUsd: p.filledAmountInUsd,
      balanceUsd: p.balanceUsd,
      giftCard: p.giftCardAmount
        ? `${p.giftCardAmount} ${p.giftCardCurrency ?? ""}`.trim()
        : null,
      // Settlement applies a tolerance, so the sign of the balance is NOT the
      // same question as "is this order settled". Use what settlement recorded.
      settled: p.shopifyFinancialStatus === "payram_paid",
      unsettled: p.shopifyFinancialStatus === "payram_partially_paid",
      syncError: p.syncError,
      updatedAt: p.updatedAt.toISOString(),
    })),
    payramBaseUrl: config?.payramBaseUrl ?? "",
    paymentMethodName:
      config?.paymentMethodName ?? "Pay with Crypto via Payram",
    hasApiKey: !!config?.payramProjectApiKeyEncrypted,
    autoGiftCardOnOverpayment: config?.autoGiftCardOnOverpayment ?? false,
    giftCardMinimumUsd: config?.giftCardMinimumUsd ?? "1.00",
    settlementTolerancePercent: config?.settlementTolerancePercent ?? "1.0",
    settlementToleranceMinUsd: config?.settlementToleranceMinUsd ?? "1.00",
  });
};

/** Plain-language explanation of each settlement state, for the merchant. */
const STATE_HELP: Record<string, string> = {
  FILLED: "Paid in full",
  PARTIALLY_FILLED: "Underpaid — do not fulfil",
  OVER_FILLED: "Overpaid — difference refunded",
  OPEN: "Awaiting payment",
  CANCELLED: "Cancelled",
  quoted: "Buyer opened the payment page",
  creating: "Creating payment link",
  created: "Payment link issued",
  failed: "Payment link could not be created",
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
  const autoGiftCardOnOverpayment =
    String(formData.get("autoGiftCardOnOverpayment") ?? "") === "on";
  const giftCardMinimumUsdRaw = String(
    formData.get("giftCardMinimumUsd") ?? "1.00"
  ).trim();
  // Guard the stored value: it is later parsed as a Decimal during settlement.
  const tolPctRaw = String(formData.get("settlementTolerancePercent") ?? "1.0").trim();
  const tolMinRaw = String(formData.get("settlementToleranceMinUsd") ?? "1.00").trim();

  // These decide how much of a shortfall still counts as paid, so a typo must be
  // rejected, not quietly replaced with a default. A merchant who meant 0.1% and
  // silently got 1.0% would be settling ten times more shortfall than intended,
  // and the form would have told them it saved.
  const settlementTolerancePercent = tolPctRaw;
  const settlementToleranceMinUsd = tolMinRaw;
  const giftCardMinimumUsd = giftCardMinimumUsdRaw;

  if (!/^\d+(\.\d{1,3})?$/.test(settlementTolerancePercent)) {
    return json({
      error:
        `Underpayment tolerance must be a plain number such as 1 or 0.5 — got "${tolPctRaw}". ` +
        "Do not include a % sign, and use a dot for decimals.",
    });
  }
  if (!/^\d+(\.\d{1,2})?$/.test(settlementToleranceMinUsd)) {
    return json({
      error:
        `Minimum tolerance must be an amount in USD such as 1.00 — got "${tolMinRaw}". ` +
        "Use a dot for decimals, with no currency symbol.",
    });
  }
  if (!/^\d+(\.\d{1,2})?$/.test(giftCardMinimumUsd)) {
    return json({
      error:
        `Minimum overpayment to refund must be an amount in USD such as 1.00 — got ` +
        `"${giftCardMinimumUsdRaw}". Use a dot for decimals, with no currency symbol.`,
    });
  }

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
      autoGiftCardOnOverpayment,
      giftCardMinimumUsd,
      settlementTolerancePercent,
      settlementToleranceMinUsd,
    },
    update: {
      payramBaseUrl,
      payramProjectApiKeyEncrypted: encryptedKey,
      paymentMethodName,
      autoGiftCardOnOverpayment,
      giftCardMinimumUsd,
      settlementTolerancePercent,
      settlementToleranceMinUsd,
    },
  });

  return json({ success: "Settings saved." });
};

export default function SettingsPage() {
  const {
    shop,
    payramBaseUrl,
    paymentMethodName,
    hasApiKey,
    autoGiftCardOnOverpayment,
    giftCardMinimumUsd,
    settlementTolerancePercent,
    settlementToleranceMinUsd,
    payments,
    needsAttention,
    hasGiftCardScope,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [baseUrl, setBaseUrl] = useState(payramBaseUrl);
  const [methodName, setMethodName] = useState(paymentMethodName);
  const [apiKey, setApiKey] = useState("");
  const [autoGiftCard, setAutoGiftCard] = useState(autoGiftCardOnOverpayment);
  const [giftCardMin, setGiftCardMin] = useState(giftCardMinimumUsd);
  const [tolPct, setTolPct] = useState(settlementTolerancePercent);
  const [tolMin, setTolMin] = useState(settlementToleranceMinUsd);

  return (
    <Page title="Payram" subtitle="Crypto payments for your store">
      <Layout>
        <Layout.Section>
          {/*
            Payram brand strip. The embedded admin stays on Polaris — Shopify
            expects its own look here and overriding it reads as broken — so the
            identity is carried by the signature neon→green hairline and mark
            from the Payram checkout, not by restyling Shopify's components.
          */}
          <div
            style={{
              position: "relative",
              overflow: "hidden",
              borderRadius: 12,
              border: "1px solid var(--p-color-border, #e3e3e3)",
              background: "var(--p-color-bg-surface, #fff)",
              padding: "0.95rem 1.1rem",
              marginBottom: "1rem",
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                height: 3,
                width: "100%",
                background: "linear-gradient(90deg, #CAFF54, #01E46F)",
              }}
            />
            <span
              aria-hidden="true"
              style={{
                width: 36,
                height: 36,
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                flex: "none",
                background: "linear-gradient(135deg, #CAFF54, #01E46F)",
                color: "#06251A",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              PR
            </span>
            <BlockStack gap="050">
              <Text as="p" variant="bodySm" tone="subdued">
                Connected store
              </Text>
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {shop}
              </Text>
            </BlockStack>
          </div>

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
          {needsAttention > 0 && (
            <Banner tone="warning" title={`${needsAttention} order${needsAttention === 1 ? "" : "s"} need attention`}>
              <p>
                These orders are underpaid, or the connector could not finish
                updating them in Shopify. See “Recent crypto payments” below for
                what happened and what to do.
              </p>
            </Banner>
          )}

          {autoGiftCardOnOverpayment && !hasGiftCardScope && (
            <Banner tone="critical" title="Overpayment refunds cannot be issued">
              <p>
                Automatic gift cards are switched on, but this store has not
                granted the app permission to create them, so overpayments are
                being recorded and left for you to refund by hand. Reopen this app
                from Shopify Admin and accept the updated permissions to fix it.
              </p>
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
                  <TextField
                    label="Underpayment tolerance (%)"
                    name="settlementTolerancePercent"
                    type="text"
                    value={tolPct}
                    onChange={setTolPct}
                    autoComplete="off"
                    helpText="How far short a crypto payment may land and still count as paid. Network fees and price movement scale with order size, so this is a percentage of the order."
                  />
                  <TextField
                    label="Minimum tolerance (USD)"
                    name="settlementToleranceMinUsd"
                    type="text"
                    value={tolMin}
                    onChange={setTolMin}
                    autoComplete="off"
                    helpText="A floor for small orders, where a percentage would be too tight. The larger of the two applies."
                  />
                  <Checkbox
                    label="Refund overpayments as a gift card"
                    name="autoGiftCardOnOverpayment"
                    checked={autoGiftCard}
                    onChange={setAutoGiftCard}
                    helpText={
                      "When a buyer sends more crypto than the order total, issue the " +
                      "difference as a Shopify gift card and email it to them. Gift cards " +
                      "work for guest buyers; store credit would require them to sign in. " +
                      "Requires gift cards to be enabled in Shopify."
                    }
                  />
                  <TextField
                    label="Minimum overpayment to refund (USD)"
                    name="giftCardMinimumUsd"
                    type="text"
                    value={giftCardMin}
                    onChange={setGiftCardMin}
                    autoComplete="off"
                    disabled={!autoGiftCard}
                    helpText="Smaller overpayments are noted on the order but not refunded, to avoid issuing gift cards for a few cents of rounding."
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

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Recent crypto payments
              </Text>

              {payments.length === 0 ? (
                <Text as="p" tone="subdued">
                  No crypto payments yet. Once a buyer pays, each order appears
                  here with what was invoiced, what arrived, and anything that
                  needs your attention.
                </Text>
              ) : (
                <BlockStack gap="200">
                  {payments.map((p) => {
                    // A shortfall inside the tolerance is settled — showing
                    // "do not fulfil" for an order the connector called paid
                    // would contradict the connector itself.
                    const short = p.unsettled;
                    // Only a refundable overpayment is worth a banner; anything
                    // inside tolerance was absorbed and needs no merchant action.
                    const over =
                      p.settled &&
                      (p.giftCard != null ||
                        (p.syncError != null && /overpaid/i.test(p.syncError)));
                    return (
                      <Card key={p.shopifyOrderId} background="bg-surface-secondary">
                        <BlockStack gap="150">
                          <Text as="h3" variant="headingSm">
                            {p.orderName ?? `Order ${p.shopifyOrderId}`} ·{" "}
                            {STATE_HELP[p.state] ?? p.state}
                          </Text>

                          <Text as="p" variant="bodySm" tone="subdued">
                            {p.orderAmount && p.currency
                              ? `Order ${p.orderAmount} ${p.currency}`
                              : "Order total not recorded"}
                            {p.invoicedUsd ? ` · invoiced $${p.invoicedUsd}` : ""}
                            {p.receivedUsd ? ` · received $${p.receivedUsd}` : ""}
                          </Text>

                          {short && (
                            <Banner tone="warning">
                              <p>
                                Underpaid by ${Math.abs(Number(p.balanceUsd)).toFixed(2)}.
                                Do not fulfil yet. The buyer can pay the balance from
                                their payment link, and this updates automatically.
                              </p>
                            </Banner>
                          )}

                          {over && (
                            <Banner tone="info">
                              <p>
                                Overpaid by ${Number(p.balanceUsd).toFixed(2)}.
                                {p.giftCard
                                  ? ` Refunded as a ${p.giftCard} gift card.`
                                  : " Not yet refunded — see the message below."}
                              </p>
                            </Banner>
                          )}

                          {p.syncError && (
                            <Banner tone="critical" title="Needs your attention">
                              <p>{p.syncError}</p>
                            </Banner>
                          )}
                        </BlockStack>
                      </Card>
                    );
                  })}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
