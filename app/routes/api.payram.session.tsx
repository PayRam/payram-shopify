/**
 * POST /api/payram/session
 *
 * The two phases behind the durable payment page. Called by `/pay/{token}`, never
 * navigated to directly.
 *
 *   { token, step: "quote" }                 → what is owed, in both currencies
 *   { token, step: "create", email? }        → a Payram checkout link for it
 *
 * Splitting the work in two is what removes the blank tab: the page renders
 * first, then reports real progress while these run.
 *
 * The order is identified only by the signed token — never by a raw order ID in
 * the request body — so this endpoint cannot be pointed at someone else's order.
 */
import type { ActionFunctionArgs } from "react-router";
import { verifyOrderToken } from "~/utils/order-token.server";
import {
  createCheckout,
  PaymentSessionError,
  quoteOrder,
} from "~/utils/payment-session.server";

const EMAIL_RE = /^[^@\s]{1,254}@[^@\s]{1,253}\.[^@\s]{1,63}$/;

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    // request.json() resolves happily for `null`, `1` and `"x"` — none of which
    // hit the catch, and all of which throw on the property read below.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const claims = verifyOrderToken(String(body.token ?? ""));
  if (!claims) {
    return Response.json(
      { error: "This payment link is not valid. Please reopen it from your order." },
      { status: 403 },
    );
  }

  const step = String(body.step ?? "quote");
  const emailRaw = typeof body.email === "string" ? body.email.trim() : "";
  const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : undefined;

  if (emailRaw && !email) {
    return Response.json({ error: "Please enter a valid email address." }, { status: 400 });
  }

  try {
    if (step === "quote") {
      const quote = await quoteOrder(claims.shop, claims.shopifyOrderId);
      return Response.json({ ok: true, quote });
    }

    if (step === "create") {
      const session = await createCheckout(
        claims.shop,
        claims.shopifyOrderId,
        email,
      );
      return Response.json({ ok: true, ...session });
    }

    return Response.json({ error: "Unknown step." }, { status: 400 });
  } catch (err) {
    if (err instanceof PaymentSessionError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[payram-session] unexpected failure:", msg);
    // Generic on system errors — never leak internals to a buyer.
    return Response.json(
      {
        error:
          "Something went wrong preparing your payment. Please try again in a moment.",
      },
      { status: 500 },
    );
  }
};
