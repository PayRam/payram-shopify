/**
 * Payram Thank You Block — Checkout UI Extension
 * Target: purchase.thank-you.block.render
 * Runtime: Shopify 2026-01
 *
 * NOTE: The extension sandbox only allows s-* custom elements.
 * No native HTML elements (div, p, img, span) are permitted.
 */

// Side-effect: registers Preact as the renderer for s-* custom elements
import "@shopify/ui-extensions/preact";
import { useApi, useShop, useTotalAmount } from "@shopify/ui-extensions/checkout/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

/* ------------------------------------------------------------------ */
/* TypeScript declarations for s-* custom elements                     */
/* ------------------------------------------------------------------ */
declare module "preact/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s-box": any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s-stack": any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s-image": any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s-text": any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s-heading": any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s-button": any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "s-text-field": any;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Settings type                                                        */
/* ------------------------------------------------------------------ */
interface PayramSettings {
  app_backend_base_url?: string;
  [key: string]: string | undefined;
}

/* ------------------------------------------------------------------ */
/* Block component                                                      */
/* ------------------------------------------------------------------ */
function PayramBlock() {
  const api = useApi<"purchase.thank-you.block.render">();

  const [appBackendBaseUrl, setAppBackendBaseUrl] = useState<string | undefined>(
    () => (api.settings.value as Partial<PayramSettings>)?.app_backend_base_url?.trim() || undefined
  );
  const [orderConfirmation, setOrderConfirmation] = useState<{ order: { id: string }; isFirstOrder: boolean } | null>(
    () => api.orderConfirmation.value ?? null
  );

  useEffect(() => {
    const unsubSettings = api.settings.subscribe((v) => {
      setAppBackendBaseUrl((v as Partial<PayramSettings>)?.app_backend_base_url?.trim() || undefined);
    });
    const unsubOrder = api.orderConfirmation.subscribe((v) => {
      setOrderConfirmation(v ?? null);
    });
    return () => { unsubSettings(); unsubOrder(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rawOrderId = orderConfirmation?.order?.id ?? "";
  const orderId = rawOrderId.split("/").pop() ?? "";
  const validOrderId = !!orderId && /^\d+$/.test(orderId);

  const totalAmount = useTotalAmount();
  const amountInUSD = totalAmount.amount;
  const shopDomain = useShop().myshopifyDomain ?? "";

  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  const handleEmailChange = (e: Event) => {
    const detail = (e as CustomEvent<{ value?: string }>).detail;
    const target = e.target as HTMLInputElement | null;
    const val = detail?.value ?? target?.value ?? "";
    setEmail(val);
    if (submitted) {
      setEmailError(isValidEmail(val) ? "" : "Please enter a valid email address.");
    }
  };

  const buildHref = () =>
    `${appBackendBaseUrl!.replace(/\/$/, "")}/api/payram/redirect-to-payment?${new URLSearchParams({
      shopifyOrderId: orderId,
      amountInUSD: String(amountInUSD),
      email,
      ...(shopDomain ? { shop: shopDomain } : {}),
    })}`;

  const handlePay = (e: Event) => {
    setSubmitted(true);
    if (!isValidEmail(email)) {
      e.preventDefault();
      setEmailError("Please enter a valid email address.");
    }
  };

  return (
    <s-box background="subdued" borderRadius="large" padding="base">
      <s-stack spacing="base">
        {/* Header */}
        <s-heading level={2}>Pay with Crypto via Payram</s-heading>

        {/* Body */}
        {!validOrderId || !appBackendBaseUrl ? (
          <s-text>
            Your order has been received. Complete your crypto payment using the link in your confirmation email.
          </s-text>
        ) : (
          <>
            <s-text>
              Your order is reserved — enter your email below and click the button to complete your crypto payment and confirm the order.
            </s-text>

            <s-text-field
              label="Email address"
              type="email"
              value={email}
              required
              onInput={handleEmailChange}
              onChange={handleEmailChange}
            />

            {emailError && (
              <s-text tone="critical" emphasis="bold">{emailError}</s-text>
            )}

            <s-button
              variant="primary"
              inlineSize="fill"
              href={isValidEmail(email) ? buildHref() : undefined}
              target="_blank"
              onClick={handlePay}
            >
              Complete Crypto Payment →
            </s-button>
          </>
        )}
      </s-stack>
    </s-box>
  );
}

/* ------------------------------------------------------------------ */
/* Default export — called by the 2026-01 runtime                      */
/* ------------------------------------------------------------------ */
export default function () {
  render(<PayramBlock />, document.body);
}

