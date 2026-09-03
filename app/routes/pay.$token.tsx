/**
 * GET /pay/{token}
 *
 * The one URL a buyer needs. It is the first payment, the live status, the
 * top-up retry, and the paid confirmation — all the same page.
 *
 * WHY A SINGLE DURABLE PAGE
 * -------------------------
 * The alternative was a second checkout extension on the order status page, but
 * `customer-account.order-status.block.render` requires `requireLogin` before
 * interaction — which would force a guest to create an account to pay their own
 * balance. A signed, bookmarkable URL needs no login, survives a closed tab, and
 * is reachable from browser history.
 *
 * WHY IT RENDERS BEFORE IT KNOWS ANYTHING
 * ---------------------------------------
 * This is a resource route returning plain HTML: no React hydration, no root
 * layout, no external calls in the loader. The buyer sees the page immediately,
 * then watches real work happen — reading the order total, fixing the exchange
 * rate, opening checkout. Previously they got a blank tab for 0.5-2s while the
 * server did all of that before sending a single byte.
 *
 * `?auto=1` (arriving from the Thank You block) proceeds straight to checkout.
 * Without it — a bookmark, browser history, a return visit — the page stops and
 * shows the current state, because the buyer did not just ask to pay.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { verifyOrderToken } from "~/utils/order-token.server";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(bodyHtml: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Crypto payment</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@600;700&display=swap">
<style>
  /*
    Payram checkout visual language, matched to
    payram-frontend/src/components/payments/CheckoutScreen.tsx so a buyer moving
    from this page into the Payram checkout sees one continuous product:
      - the neon→green 3px hairline along the card's top edge (the signature)
      - 20px card radius, 1px border, 0 2px 8px shadow
      - gradient avatar with #06251A initials
      - 11px muted label above a semibold value
    Tokens are from payram-frontend/src/styles/themes.css. UI text is Inter and
    the amount is Poppins, following that repo's payments-surface convention.
  */
  :root {
    --pr-primary: #09984E;
    --pr-primary-hover: #078040;
    --pr-primary-soft: rgba(1, 228, 111, 0.10);
    --pr-on-primary: #ffffff;
    --pr-accent: #CAFF54;
    --pr-surface: #ffffff;
    --pr-surface-sunken: #f8fafc;
    --pr-bg: #f1f5f9;
    --pr-text: #0f172a;
    --pr-text-secondary: #475569;
    --pr-text-muted: #94a3b8;
    --pr-border: #e2e8f0;
    --pr-border-subtle: #f1f5f9;
    --pr-border-strong: #cbd5e1;
    --pr-success: #10b981;
    --pr-success-soft: rgba(16, 185, 129, 0.10);
    --pr-success-text: #065f46;
    --pr-warning: #f59e0b;
    --pr-warning-soft: rgba(245, 158, 11, 0.10);
    --pr-warning-text: #92400e;
    --pr-destructive: #ef4444;
    --pr-destructive-soft: rgba(239, 68, 68, 0.10);
    --pr-destructive-text: #991b1b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --pr-primary: #01E46F;
      --pr-primary-hover: #00cc60;
      --pr-primary-soft: rgba(1, 228, 111, 0.12);
      /* On the bright brand green, Payram uses a near-black green, not white. */
      --pr-on-primary: #06251A;
      --pr-surface: #1e293b;
      --pr-surface-sunken: #0f172a;
      --pr-bg: #0f172a;
      --pr-text: #f1f5f9;
      --pr-text-secondary: #94a3b8;
      --pr-text-muted: #64748b;
      --pr-border: #334155;
      --pr-border-subtle: #1e293b;
      --pr-border-strong: #475569;
      --pr-success-text: #6ee7b7;
      --pr-warning-text: #fcd34d;
      --pr-destructive-text: #fca5a5;
    }
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--pr-bg); color: var(--pr-text);
    font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5; padding: 1.5rem;
    display: flex; justify-content: center; align-items: flex-start; min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  main {
    position: relative; overflow: hidden;
    width: 100%; max-width: 27rem; background: var(--pr-surface);
    border: 1px solid var(--pr-border); border-radius: 20px;
    padding: 1.5rem; margin-top: 2rem;
    display: flex; flex-direction: column; gap: 1.1rem;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }
  /* Payram signature: neon→green hairline along the top edge. */
  main::before {
    content: ""; position: absolute; left: 0; top: 0; height: 3px; width: 100%;
    background: linear-gradient(90deg, #CAFF54, #01E46F);
  }

  .payee { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
  .avatar {
    width: 2.75rem; height: 2.75rem; border-radius: 50%; flex: none;
    display: grid; place-items: center;
    background: linear-gradient(135deg, #CAFF54, #01E46F);
    color: #06251A; font-family: Poppins, Inter, sans-serif; font-weight: 700;
    font-size: 0.85rem; letter-spacing: 0.02em;
  }
  .label { font-size: 0.6875rem; color: var(--pr-text-muted); }
  .payee strong { font-weight: 600; font-size: 0.95rem; display: block; }

  h1 { font-family: Poppins, Inter, sans-serif; font-size: 1.25rem; font-weight: 600; margin: 0; line-height: 1.25; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--pr-text-secondary); font-size: 0.875rem; }

  .rows { display: flex; flex-direction: column; border: 1px solid var(--pr-border); border-radius: 14px; overflow: hidden; background: var(--pr-surface-sunken); }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; padding: 0.7rem 0.9rem; border-bottom: 1px solid var(--pr-border-subtle); }
  .row:last-child { border-bottom: none; }
  .row span:first-child { color: var(--pr-text-muted); font-size: 0.6875rem; }
  .row span:last-child { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 0.875rem; }
  /* The figure that matters most gets the display face. */
  .row.due span:last-child, .row.paid span:last-child {
    font-family: Poppins, Inter, sans-serif; font-size: 1.35rem; font-weight: 700; letter-spacing: -0.01em;
  }
  .row.due span:last-child { color: var(--pr-warning-text); }
  .row.paid span:last-child { color: var(--pr-success-text); }
  .rate { font-size: 0.6875rem; color: var(--pr-text-muted); font-variant-numeric: tabular-nums; }

  .pill {
    display: inline-block; font-size: 0.5625rem; font-weight: 600;
    padding: 0.15rem 0.45rem; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.05em;
  }
  .pill.warn { background: var(--pr-warning-soft); color: var(--pr-warning-text); }
  .pill.ok { background: var(--pr-primary-soft); color: var(--pr-primary); }

  button {
    font-family: Poppins, Inter, sans-serif; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    background: var(--pr-primary); color: var(--pr-on-primary);
    border: none; border-radius: 14px; padding: 0.9rem 1rem; width: 100%;
    transition: background 140ms ease, transform 140ms ease;
  }
  button:hover:not(:disabled) { background: var(--pr-primary-hover); transform: translateY(-1px); }
  button:active:not(:disabled) { transform: translateY(0); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--pr-primary); outline-offset: 2px; }

  .steps { display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
  .steps li { display: flex; gap: 0.6rem; align-items: center; color: var(--pr-text-muted); font-size: 0.8125rem; transition: color 200ms ease; }
  .steps li[data-state="active"], .steps li[data-state="done"] { color: var(--pr-text); }
  .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--pr-border-strong); flex: none; transition: background 200ms ease; }
  .steps li[data-state="active"] .dot { background: var(--pr-accent); box-shadow: 0 0 0 4px var(--pr-primary-soft); animation: pulse 1.1s ease-in-out infinite; }
  .steps li[data-state="done"] .dot { background: var(--pr-primary); }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
  @media (prefers-reduced-motion: reduce) {
    .steps li .dot { animation: none !important; }
    button, .steps li { transition: none; }
    button:hover:not(:disabled) { transform: none; }
  }

  .banner { padding: 0.8rem 0.9rem; border-radius: 14px; font-size: 0.8125rem; border: 1px solid transparent; }
  .banner.err { background: var(--pr-destructive-soft); color: var(--pr-destructive-text); border-color: var(--pr-destructive); }
  .banner.ok { background: var(--pr-success-soft); color: var(--pr-success-text); border-color: var(--pr-success); }
  .banner.warn { background: var(--pr-warning-soft); color: var(--pr-warning-text); border-color: var(--pr-warning); }

  a { color: var(--pr-primary); }
  .fine { font-size: 0.6875rem; color: var(--pr-text-muted); }
  [hidden] { display: none !important; }
</style>
</head>
<body><main>${bodyHtml}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const token = params.token ?? "";
  const claims = verifyOrderToken(token);

  if (!claims) {
    return page(
      `<div class="payee">
         <span class="avatar" aria-hidden="true">PR</span>
         <span><span class="label">Paying with</span><strong>Payram · crypto</strong></span>
       </div>
       <h1>This payment link isn't valid</h1>
       <p>It may have been mistyped or truncated. Open your order confirmation
          and use the payment link there.</p>`,
      404,
    );
  }

  const auto = new URL(request.url).searchParams.get("auto") === "1";

  // Rendered immediately; every number below is filled in by the quote call.
  return page(`
    <div class="payee">
      <span class="avatar" aria-hidden="true">PR</span>
      <span>
        <span class="label">Paying with</span>
        <strong id="payee-name">Payram · crypto</strong>
      </span>
    </div>
    <h1 id="title">Preparing your crypto payment</h1>
    <p id="lede">Your order is confirmed. You have not been charged yet.</p>

    <ul class="steps" id="steps">
      <li data-step="quote" data-state="active"><span class="dot"></span><span>Confirming your order total</span></li>
      <li data-step="rate"><span class="dot"></span><span>Fixing your exchange rate</span></li>
      <li data-step="checkout"><span class="dot"></span><span>Opening secure checkout</span></li>
    </ul>

    <div id="summary" hidden>
      <div class="rows">
        <div class="row"><span>Order total</span><span id="v-total">—</span></div>
        <div class="row" id="r-received" hidden><span>Already received</span><span id="v-received">—</span></div>
        <div class="row due" id="r-due"><span>Amount due</span><span id="v-due">—</span></div>
      </div>
      <p class="rate" id="v-rate" hidden></p>
    </div>

    <div class="banner ok" id="ok" hidden></div>
    <div class="banner warn" id="warn" hidden></div>
    <div class="banner err" id="err" hidden></div>

    <button id="go" hidden>Pay now</button>
    <p class="fine" id="fine" hidden>
      Keep this page bookmarked — you can return to it any time to check or finish your payment.
    </p>

<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var AUTO = ${auto ? "true" : "false"};

  // The email arrives for one hop from the Thank You block. Use it for this
  // payment, then scrub it from the URL so a bookmarked link never carries it.
  var EMAIL = null;
  try {
    var q = new URLSearchParams(location.search);
    EMAIL = q.get("email");
    if (EMAIL && window.history && history.replaceState) {
      q.delete("email");
      var clean = location.pathname + (q.toString() ? "?" + q.toString() : "");
      history.replaceState(null, "", clean);
    }
  } catch (e) { /* URL cleanup is best-effort */ }

  var el = function (id) { return document.getElementById(id); };
  var steps = el("steps");
  var quote = null;

  function setStep(name, state) {
    var li = steps.querySelector('[data-step="' + name + '"]');
    if (li) li.setAttribute("data-state", state);
  }
  function show(id, text) {
    var n = el(id);
    if (text != null) n.textContent = text;
    n.hidden = false;
  }
  function hide(id) { el(id).hidden = true; }

  function fail(message) {
    steps.hidden = true;
    el("title").textContent = "We couldn't prepare your payment";
    el("lede").textContent = "Your order is safe and you have not been charged.";
    show("err", message);
    var go = el("go");
    go.textContent = "Try again";
    go.hidden = false;
    go.disabled = false;
    go.onclick = function () { location.reload(); };
    show("fine");
  }

  function post(step, extra) {
    var body = { token: TOKEN, step: step };
    if (extra) for (var k in extra) body[k] = extra[k];
    return fetch("/api/payram/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || "Something went wrong. Please try again.");
        return j;
      });
    });
  }

  function renderQuote(q) {
    quote = q;
    if (q.orderName) el("payee-name").textContent = "Payram · " + q.orderName;
    el("v-total").textContent = q.orderTotal + " " + q.currency;
    el("v-due").textContent = q.remainingLocal + " " + q.currency;

    if (Number(q.receivedUsd) > 0) {
      // Same currency as the other rows, so received + due visibly equals the total.
      el("v-received").textContent = q.receivedLocal + " " + q.currency;
      el("r-received").hidden = false;
    }
    if (q.currency !== "USD") {
      show("v-rate", "Charged as $" + q.remainingUsd + " USD at a rate of " + q.fxRate + " USD per " + q.currency + ".");
    }
    show("summary");
  }

  function toCheckout() {
    steps.hidden = false;
    setStep("checkout", "active");
    el("go").disabled = true;
    post("create", EMAIL ? { email: EMAIL } : null).then(function (res) {
      setStep("checkout", "done");
      location.href = res.checkoutUrl;
    }).catch(function (e) { fail(e.message); });
  }

  post("quote").then(function (res) {
    setStep("quote", "done");
    setStep("rate", "done");
    renderQuote(res.quote);

    if (res.quote.phase === "paid") {
      steps.hidden = true;
      el("title").textContent = "Paid in full";
      el("lede").textContent = "Thank you — your crypto payment is complete. Nothing further is due.";
      el("r-due").className = "row paid";
      el("v-due").textContent = "0.00 " + res.quote.currency;
      show("ok", "You can close this page. Your order confirmation has been updated.");
      show("fine");
      return;
    }

    // Nothing further is happening until the buyer acts, so stop showing
    // progress for work that is not running.
    if (!AUTO) steps.hidden = true;

    if (res.quote.phase === "partial") {
      el("title").textContent = "Your payment is incomplete";
      el("lede").textContent = "We received part of your payment. Pay the remaining balance to complete your order.";
      show("warn", "Your order will not be fulfilled until the balance is paid.");
    } else {
      el("title").textContent = "Pay with crypto";
      el("lede").textContent = "Your order is confirmed. You have not been charged yet.";
    }

    var go = el("go");
    go.textContent = "Pay " + res.quote.remainingLocal + " " + res.quote.currency + " in crypto";
    go.onclick = toCheckout;
    go.hidden = false;
    show("fine");

    // Arriving straight from the Thank You page: the buyer already asked to pay.
    if (AUTO) toCheckout();
  }).catch(function (e) { fail(e.message); });
})();
</script>
  `);
};
