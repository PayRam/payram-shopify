# Payram Shopify Connector

**Accept crypto payments on Shopify — from your own server, into your own wallet.**

There is no Payram account to create. No KYB, no application, no approval queue, no
onboarding call. You run the connector on your own infrastructure and point it at your own
[Payram](https://www.payram.com) instance — there is nothing to sign up for because there
is no intermediary to sign up with.

| What merchants ask | Why the answer holds here |
|---|---|
| Is my customer data shared? | It never leaves your server. Payram cannot see it. |
| Can my account be locked? | There is no account to lock — you run the server. |
| Can my funds be frozen? | Self-custody. Deposits land in your wallet, not someone else's float. |
| Is anything reported about my sales? | Nothing is reported to anyone. |
| What if my server is breached? | Deposit keys are not on it — smart contracts move funds on-chain. |

Buyers pay in BTC, ETH, TRX, BASE or POLYGON assets and never create an account either —
the whole flow works for **guest checkout**.

---

## For AI agents

Read this section first if you are configuring, extending or debugging this connector.

**What this is.** A [Remix](https://remix.run) app (Node ≥ 18, Prisma + SQLite) sitting
between a Shopify store and a self-hosted Payram instance. It holds no funds and never sees
a private key. It decides *how much to charge*, *in what currency*, and *what an arriving
payment means for the Shopify order*.

**The flow in one paragraph.** A buyer checks out with a manual payment method, so Shopify
places the order unpaid. A checkout extension on the Thank You page links to
`/api/payram/redirect-to-payment`, which mints a signed token and redirects to
`/pay/{token}` — the durable payment page. That page reads the order total from the Shopify
Admin API (never from the browser), converts it to USD (Payram settles in USD only), creates
a Payram payment, and sends the buyer to Payram's hosted checkout. When funds arrive, Payram
webhooks `/api/payram/webhook`, which settles the order: tag it paid, flag it underpaid, or
refund an overpayment as a gift card.

**Where to start, by task:**

| Task | Go to |
|---|---|
| Install / configure a store | [Self-Hosted Installation](#self-hosted-installation), [Configuration Reference](#configuration-reference) |
| Understand what a buyer sees | [The Buyer's Journey](#the-buyers-journey) |
| Work out why an order looks wrong | [Diagnostics](#diagnostics) |
| Understand money handling | [Currency Handling](#currency-handling), [Partial and Overpayments](#partial-and-overpayments) |
| Change settlement behaviour | `app/utils/settlement.server.ts` |
| Check the security posture | `state/malicious-flows.md` |

**Invariants — do not break these.** Each one exists because breaking it cost real money:

1. **Never take the amount from the browser.** It arrives on an unsigned request. Read it
   from the Shopify Admin API.
2. **Payram settles in USD only.** Its rate oracle handles crypto→USD; it has no fiat rates.
   Convert before calling `/api/v1/payment`, and fail closed if no rate is available.
3. **Money is `TEXT` in the database and `Decimal` in code — never a float.** SQLite's
   NUMERIC affinity silently demotes `DECIMAL` to floating point.
4. **The Payram webhook is unsigned.** Never mint value (gift cards) from it without
   re-reading the payment from Payram *and* checking it belongs to that order.
5. **An unrecognised payment status must never settle an order.** Unknown means unknown.
6. **Never create a Payram payment from the webhook.** Payram re-sends every 3 seconds
   during confirmation, and creating a payment cancels the buyer's live checkout link.
7. **Charge the outstanding balance, not the order total** — otherwise an order part-paid
   by a gift card gets billed twice.

---

## Self-Hosted Installation

### Prerequisites

| Requirement | Notes |
|---|---|
| Docker | [docs.docker.com/get-docker](https://docs.docker.com/get-docker/) |
| A Shopify Partner account | [partners.shopify.com](https://partners.shopify.com) |
| A Payram account + project | [payram.com](https://www.payram.com) |

No Node.js required on the host — everything runs inside Docker.

---

### Step 1 — Run the installer

On your server (Linux or macOS), run:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/PayRam/payram-shopify/main/setup_payram_shopify.sh)"
```

The script will:

1. Check Docker is installed and running
2. Ask for an install directory (default: `~/payram-shopify-connector`)
3. Prompt for your Shopify app's **Client ID** and **Client Secret** — get these from [partners.shopify.com](https://partners.shopify.com) → Apps → your app → API credentials
4. Ask for your server's public HTTPS URL and optional database connection string
5. Auto-generate an encryption key using `openssl`
6. Pull the Docker image and start the container
7. Optionally deploy the checkout UI extension to Shopify's CDN

---

### Step 2 — Deploy the checkout UI extension

The installer offers to do this automatically. If you skipped it, run:

```bash
docker run --rm -it \
  --env-file ~/payram-shopify-connector/.env \
  payramapp/payram-shopify:latest \
  npx shopify app deploy
```

---

### Step 3 — Start the server

The container is already running after the installer. To manage it:

```bash
docker logs payram-shopify-connector     # view logs
docker stop payram-shopify-connector     # stop
docker start payram-shopify-connector    # restart
```

---

### Step 4 — Install the app on your Shopify store

Open the following URL in a browser (replace placeholders):

```
https://YOUR_DOMAIN/auth?shop=YOUR_STORE.myshopify.com
```

Approve the permission request. This installs the app on your store and creates a session.

---

### Step 5 — Configure Payram credentials

1. After installation, the app opens in **Shopify Admin → Apps → Payram Connector**.
2. On the **Settings** page, enter:
   - **Payram Base URL** — your Payram instance URL (e.g. `https://api.payram.com`)
   - **Payram Project API Key** — from your Payram dashboard
3. Click **Save Settings**, then **Test Payram Connection** to verify.

---

### Step 6 — Add the manual payment method in Shopify

1. In Shopify Admin → **Settings** → **Payments** → **Manual payment methods** → **Add manual payment method**.
2. Enter the name your customers will see, e.g.:
   ```
   Pay with Crypto via Payram
   ```

---

### Step 7 — Add the Payram block to the Thank You page

1. In Shopify Admin → **Online Store** → **Checkout** → **Customize**.
2. Switch to the **Thank You** page using the page selector at the top.
3. Click **Add block** → select **Payram Thank You Block**.
4. In the block settings panel set **App backend base URL** to your server's public URL, e.g.:
   ```
   https://YOUR_DOMAIN
   ```
5. Click **Save**.

---

### Step 8 — Test end-to-end

1. Go to your store and place an order using the *Pay with Crypto via Payram* payment method.
2. On the Thank You page the Payram block appears.
3. Enter an email address and click **Complete Crypto Payment**.
4. You are redirected to a Payram-hosted checkout to complete the crypto payment.

---

## Configuration Reference

Configuration lives in three places. An agent changing behaviour should know which.

### 1. Environment (server)

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_API_KEY` | ✅ | Shopify app Client ID |
| `SHOPIFY_API_SECRET` | ✅ | Shopify app Client secret. Also the fallback signer for payment links |
| `SHOPIFY_APP_URL` | ✅ | Public HTTPS URL of this server. Used to build absolute redirects for App Proxy requests |
| `DATABASE_URL` | ✅ | SQLite (`file:prod.sqlite`) or Postgres connection string |
| `ENCRYPTION_KEY` | ✅ | 64-char hex key encrypting stored Payram API keys (AES-256-GCM) |
| `SCOPES` | ✅ | `read_orders,write_orders,read_customers,write_customers,write_app_proxy,write_gift_cards` (do not change) |
| `PAYMENT_LINK_SECRET` | **production** | Signs `/pay/{token}` links. Falls back to `SHOPIFY_API_SECRET` — see the warning below |
| `PORT` | — | Server port (default `2798`) |
| `PAYRAM_BASE_URL` / `PAYRAM_PROJECT_API_KEY` | — | Dev shortcut to skip the Settings page. Per-shop DB config wins |
| `ALLOW_INSECURE_PAYRAM_URL` | — | Dev only. Disables SSRF protection on the Payram URL. **Never set in production** |

> **Set `PAYMENT_LINK_SECRET` explicitly in production.** Without it, links are signed with
> `SHOPIFY_API_SECRET`, so rotating your Shopify credentials invalidates *every outstanding
> payment link* — including links held by buyers who have already part-paid.

The installer (`setup_payram_shopify.sh`) **rewrites `SCOPES` on every run**. If you add a
scope, change it there too or it will be silently reverted on the next install.

### 2. Merchant settings (Payram app in Shopify Admin)

Stored per shop in `MerchantConfig`. Everything money-affecting is validated on save and
rejected — never silently defaulted.

| Setting | Default | Effect |
|---|---|---|
| Payram Base URL | — | Your Payram instance. Must be HTTPS; private/loopback ranges are blocked |
| Payram Project API Key | — | Encrypted at rest |
| Payment Method Name | `Pay with Crypto via Payram` | Label buyers see |
| Underpayment tolerance (%) | `1.0` | Shortfall that still counts as paid, as a share of the order |
| Minimum tolerance (USD) | `1.00` | Floor for small orders. The **larger** of the two applies |
| Refund overpayments as a gift card | `off` | Needs `write_gift_cards` **and** gift cards enabled in Shopify |
| Minimum overpayment to refund (USD) | `1.00` | Smaller excess is noted on the order, not refunded |

Effective tolerance is `max(invoice × percent, floor)` — proportional because network fees
and price drift scale with order size. A $1,000 order allows $10; a $20 order allows $1.

### 3. Shopify-side prerequisites

- A **manual payment method** named to match the setting above.
- The **Payram Thank You Block** added in the checkout editor.
- **Gift cards enabled** (Settings → Gift cards) if refunding overpayments.
- **Re-authorization** after any scope change — merchants must reopen the app and accept.

---

## Updating

```bash
docker pull payramapp/payram-shopify:latest
docker stop payram-shopify-connector && docker rm payram-shopify-connector
docker run -d \
  --name payram-shopify-connector \
  --env-file ~/payram-shopify-connector/.env \
  -p 2798:2798 \
  -v payram-shopify-data:/data \
  --restart unless-stopped \
  payramapp/payram-shopify:latest
```

---

## Quick Start (local dev)

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Fill in:

```env
# from Shopify Partner Dashboard → App → Client credentials
SHOPIFY_API_KEY=your_key
SHOPIFY_API_SECRET=your_secret
SCOPES=read_orders,write_orders,read_customers,write_customers,write_app_proxy,write_gift_cards
SHOPIFY_APP_URL=https://your-tunnel.trycloudflare.com

DATABASE_URL="file:dev.sqlite"

# 64-char hex key — generate with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=your_64_char_hex_key
```

> During `shopify app dev` the tunnel URL is printed in the console. Update `SHOPIFY_APP_URL` to match.

### 3. Run database migrations

```bash
npx prisma migrate dev --name init
```

### 4. Start the app

```bash
shopify app dev
```

This starts the Remix server, creates a Cloudflare tunnel, and streams logs.

### 5. Configure Payram credentials in the app

1. Open the app in Shopify Admin (follow the install URL from the terminal).
2. On the **Settings** page enter:
   - **Payram Base URL** — e.g. `https://api.payram.io`
   - **Payram Project API Key**
3. Click **Save Settings**.
4. Click **Test Payram Connection** to verify the credentials.

### 6. Add the manual payment method in Shopify

In Shopify Admin → Settings → Payments → Manual payment methods:

```
Pay with Crypto via Payram
```

### 7. Add the Payram block to the Thank You page

1. In Shopify Admin → Online Store → Checkout → Customize.
2. Navigate to the **Thank You** page.
3. Add the **Payram Thank You Block** from the extension list.
4. In the block settings, set:
   - **App backend base URL** → the current Cloudflare tunnel URL (e.g. `https://xyz.trycloudflare.com`)
5. Save.

> **Important:** The Cloudflare tunnel URL changes every time you restart `shopify app dev`. Update this setting each time.

### 8. Place a test order

1. Go to your development store → place an order using the manual payment method.
2. On the Thank You page the Payram block appears.
3. Optionally enter an email address.
4. Click **Open Payram checkout** — you will be redirected to the Payram payment page.

---

## Backend Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/pay/{token}` | **The buyer-facing payment page.** Status, first payment, top-up, receipt |
| `POST` | `/api/payram/session` | Quote / create-checkout, called by the payment page |
| `GET` | `/api/payram/redirect-to-payment` | Entry point from the Thank You block; mints a token and redirects to `/pay/{token}` |
| `GET` | `/api/payram/status` | Returns PaymentMapping for an order or reference |
| `POST` | `/api/payram/webhook` | Receives Payram payment status webhooks |

### `GET /api/payram/redirect-to-payment`

Query params:

| Param | Required | Description |
|-------|----------|-------------|
| `shopifyOrderId` | Yes | Numeric Shopify order ID |
| `shop` | Yes | `*.myshopify.com` domain |
| `email` | No | Buyer email for Payram receipt |
| `amountInUSD` | — | **Ignored.** Older extension bundles still send it; the server never reads it. |

Behaviour — **this route does no payment work**. It validates, records the buyer's email
against an existing mapping, mints a signed token and redirects to `/pay/{token}?auto=1`.
It is kept at this URL because checkout extension bundles deploy separately from the server,
so merchants on an older bundle still link here.

When debugging a payment, the work happens in the two routes below, not this one.

### `GET /pay/{token}`

The durable buyer-facing payment page. Plain HTML, no React hydration, no external calls in
the loader — it renders immediately, then calls `/api/payram/session` for the real numbers.
`?auto=1` proceeds straight to checkout; without it the page stops and shows current state.

### `POST /api/payram/session`

Where the money logic lives. The order is identified **only** by the signed token, never by a
raw order ID in the body.

| Body | Does |
|---|---|
| `{ token, step: "quote" }` | Reads the outstanding total from the Shopify Admin API (`totalOutstandingSet`), strikes the USD invoice once and stores it, sums everything received, returns amounts in both currencies |
| `{ token, step: "create", email? }` | Compare-and-set claims the order, reuses the live Payram link if the amount is unchanged, otherwise calls `POST {payramBaseUrl}/api/v1/payment` for the outstanding balance |

If no live exchange rate is available the payment is **not** created and the buyer is asked to
retry — see [Currency Handling](#currency-handling).

### `POST /api/payram/webhook`

Expected JSON body (accepts common field name variants):

```json
{
  "referenceId": "payram-ref-id",
  "status": "paid"
}
```

Terminal statuses that trigger Shopify sync: `paid`, `confirmed`, `closed`, `completed`.

---

## Payram API Contract

```
POST {PAYRAM_BASE_URL}/api/v1/payment
Headers:
  API-Key: {PAYRAM_PROJECT_API_KEY}
  Content-Type: application/json

Body:
{
  "customerId": "shopify:{shop}:order:{shopifyOrderId}",
  "amountInUSD": 54.22,                  // order total CONVERTED to USD
  "invoiceID": "{shopifyOrderId}",       // shows the order number in Payram
  "customerEmail": "buyer@example.com"   // optional
}

Expected response:
{
  "referenceId": "...",
  "checkoutUrl": "https://..."
}
```

The connector also accepts `reference_id`/`id` and `checkout_url`/`paymentUrl` variants.

---

## Currency Handling

**Payram settles in USD.** `POST /api/v1/payment` accepts an `amountInUSD` field and nothing else —
there is no fiat currency parameter, and payram-core's rate oracle converts *crypto* to USD only, so
the server has no EUR or GBP rates to apply. A connector must therefore convert before it calls
Payram.

If your store prices in anything other than USD, the connector does this for you:

1. The order total is read from Shopify server-side, using `currentTotalPriceSet.presentmentMoney` —
   the amount and currency the buyer was actually invoiced in (this is what Shopify Markets shows a
   buyer in their local currency, which can differ from your store's default).
2. That total is converted to USD using a live rate from `open.er-api.com`, cached for one hour in
   the `FxRate` table. This is the same provider and cache window the PayRam WooCommerce plugin uses.
3. The original amount, currency, rate and source are written to `PaymentMapping` so every payment
   can be reconciled against its Shopify order.

**If no live rate is available, no payment is created.** The buyer sees "Exchange rate unavailable"
and is asked to retry; the order is left untouched. Creating the payment at a guessed or unconverted
rate would silently short the merchant, which is far more expensive to unwind than a retried
checkout. This is the same stance payram-core takes on payouts, where a stale rate raises
`EXCHANGE_RATE_UNAVAILABLE` rather than proceeding.

Rate movement between checkout and settlement is not hedged, matching the WooCommerce connector's
documented v1 behaviour.

> **Historical note.** Before this was implemented, the Thank You block sent the raw order total to
> the server under the name `amountInUSD` and the number was passed through untouched. A €50 order
> was created in Payram as a $50 payment, and because nothing downstream compared amounts the order
> was still tagged `payram_paid`. Every non-USD merchant lost the FX spread on every order. If you
> ran an earlier build against a non-USD store, audit your Payram payments against the Shopify order
> totals for that period.

---

## The Buyer's Journey

```
Shopify checkout          buyer picks "Pay with Crypto via Payram"
        │                 order is placed, unpaid — works for guests
        ▼
Thank You page            our block: order total + "Continue to crypto payment →"
        │                 same tab (a new tab is easily lost on mobile)
        ▼
/api/payram/redirect-to-payment    validates, stores the email, mints a signed token
        │                          302 — does no slow work of its own
        ▼
/pay/{token}?auto=1       renders INSTANTLY, then shows real progress:
        │                   Confirming your order total
        │                   Fixing your exchange rate   →  €50.00 = $54.22 at 1.0845
        │                   Opening secure checkout
        ▼
Payram hosted checkout    chain, coin, deposit address, confirmations
```

### Why the payment page is a separate, durable URL

`/pay/{token}` is the **only** URL a buyer needs. It is the first payment, the live status, the
top-up retry, and the paid confirmation — the same link, showing whichever of those is currently
true. Consequences worth knowing:

- **No login, ever.** The obvious alternative was a `customer-account.order-status.block.render`
  extension, but that target requires `requireLogin` before interaction — a guest would have to
  create an account to pay their own balance.
- **Survives a closed tab.** It is bookmarkable and reachable from browser history, which is what
  makes same-tab navigation safe.
- **Cannot be repointed.** The order travels as an HMAC-signed token, so a link cannot be edited
  into someone else's order. (This does not make orders unenumerable — see
  `state/malicious-flows.md`, MF-003.)
- **Renders before it knows anything.** It is a plain-HTML resource route with no React hydration
  and no external calls in the loader. Previously the buyer got a blank tab for 0.5–2s while the
  server did the Admin API lookup, the FX conversion and the Payram call before sending a byte.

### Returning to pay a balance

A buyer who underpays reopens the same link and sees what is still due, with a button to pay
exactly that. The connector reuses the live Payram link while the amount is unchanged, and issues a
new one when it moves — never on every page view, because `payram-core` cancels a member's
previously open payment request, which would kill the link the buyer is part-way through paying.

Set `PAYMENT_LINK_SECRET` in production. Without it the app falls back to `SHOPIFY_API_SECRET`, and
rotating that would invalidate every outstanding payment link at once.

---

## Partial and Overpayments

Crypto payments are not all-or-nothing. A buyer can send slightly less (network fees, rounding, a
price tick between quote and send) or slightly more. Payram already classifies this on every webhook
as `FILLED`, `PARTIALLY_FILLED` or `OVER_FILLED`, and the connector acts on all three.

### What happens automatically

| Situation | Order tags | Order note | Money |
|---|---|---|---|
| Paid in full | `payram_paid` | "paid in full" | — |
| **Underpaid** | `payram_partially_paid` | "Still due €13.11 — do not fulfil" | none moved |
| **Overpaid** | `payram_paid` + `payram_overpaid` | excess recorded | gift card issued for the difference |

An underpaid order is **never** tagged `payram_paid`. That is the whole point: previously a short
payment and a complete one were indistinguishable.

Differences are shown in USD *and* in the currency the order was placed in, converted at the rate
stored on the order when the invoice was struck — so "still due" does not drift as exchange rates
move.

### Top-ups

If a buyer underpays and then sends more crypto, `payram-core` does **not** add it to the original
payment request — it creates a new one with a new `referenceID`. The connector traces those back via
`customer_id` (which is `shopify:{shop}:order:{orderId}` and unchanged), sums every payment for the
order, and settles when the total covers the invoice. Webhook retries cannot double-count: payments
are keyed by reference in the `PayramPayment` table.

### Why gift cards, not store credit

Overpayments are refunded as a **Shopify gift card**, not store credit:

| | Guest buyer | Signed-in buyer |
|---|---|---|
| **Gift card** | ✅ works — it's a code, emailable to anyone | ✅ works |
| **Store credit** | ❌ cannot be spent — requires customer accounts or Shop Pay sign-in | ✅ works |

Most crypto checkouts are guest checkouts, so store credit would silently strand the refund for the
majority of buyers. A gift card works for everyone, which is why it is the single path rather than a
branch that can fail. Discount codes are not used: they are a percentage or amount off, not a stored
balance — they don't decrement, can be shared, and don't represent money owed.

### Merchant setup

1. **Enable gift cards in Shopify** — Settings → *Gift cards*. Without this, card creation is
   rejected and the connector records a warning on the order instead.
2. **Re-authorize the app.** Issuing gift cards needs the `write_gift_cards` scope. Existing
   installs must reopen the Payram app in Shopify Admin once and accept the updated permissions.
3. **Turn it on** — in the Payram app, tick *Refund overpayments as a gift card* and set the minimum
   (default `1.00` USD). It is **off by default**, because it moves money.

### Merchant operations

**Underpaid order**
1. The order appears tagged `payram_partially_paid` with the shortfall in the note.
2. Do not fulfil. Contact the buyer with the amount still due, or refund what was received.
3. If the buyer sends the rest, the connector adds it automatically and re-tags the order
   `payram_paid`. No merchant action needed.

**Overpaid order**
1. The order appears tagged `payram_paid` and `payram_overpaid`.
2. A gift card for the difference is created and — when the order has a customer — emailed by
   Shopify automatically. The note records the amount and the card's last characters.
3. If the buyer had no customer record, the note says so; send the code from Shopify Admin →
   *Gift cards*.
4. Fulfil as normal. The order is paid.

**Where to see problems.** Open the Payram app in Shopify Admin. Any order that is underpaid, or
that the connector could not finish updating, is listed under *Recent crypto payments* with what
happened in plain words, and the page warns you at the top if overpayment refunds are switched on
without the permission needed to issue them.

**When something needs a human.** Anything the connector could not do lands in
`PaymentMapping.syncError` and in the order note, in plain words — gift cards disabled, an
overpayment below the minimum, a payment Payram could not confirm. The connector never guesses and
never silently swallows a discrepancy.

> **Security note.** The Payram webhook is unsigned, so the connector re-reads every payment from
> Payram (`GET /api/v1/payment/reference/{id}`) before acting, and issues a gift card only when that
> verification succeeds. A forged webhook cannot mint value. See `state/malicious-flows.md` (MF-008).

---

## Diagnostics

Every failure the connector can see is written somewhere observable. Nothing is swallowed.

### Where to look, in order

1. **The Payram app in Shopify Admin** — *Recent crypto payments* lists each order with what
   was invoiced, what arrived, and any problem in plain words. Warning banners at the top
   flag orders needing attention and misconfigured gift card refunds.
2. **The Shopify order** — tags and an order note record every settlement decision.
3. **`PaymentMapping.syncError`** — the durable record of anything that failed.
4. **Server logs** — every line is prefixed, so grep by stage.

### Log prefixes

| Prefix | Stage |
|---|---|
| `[payram-entry]` | Thank You block → token minted → redirect to the payment page |
| `[payram-session]` | Quote and checkout-link creation behind `/pay/{token}` |
| `[payram-admin]` | Shopify Admin API calls (order lookup, tags, notes, gift cards) |
| `[payram-fx]` | Fiat→USD rate lookups and caching |
| `[payram-webhook]` | Inbound Payram webhooks |
| `[payram-verify]` | Re-reading a payment from Payram before acting on it |
| `[payram-settle]` | Settlement decisions |

### Order tags

| Tag | Meaning | Fulfil? |
|---|---|---|
| `payram_paid` | Settled — received covers the invoice within tolerance | Yes |
| `payram_partially_paid` | Underpaid. The note names the exact balance due | **No** |
| `payram_overpaid` | Paid, and the excess was refunded (or flagged for manual refund) | Yes |

### Symptom → cause → fix

| Symptom | Signal | Cause | Fix |
|---|---|---|---|
| Orders never tagged paid | `[payram-webhook] settling` present, no tag | Webhook status not recognised, or ownership check failed | Check the `syncError` on the order; confirm the payment in Payram |
| Buyer sees "Exchange rate unavailable" | `[payram-fx] rate provider unreachable` | No egress to `open.er-api.com` | Allow outbound HTTPS. **Never** bypass — no payment is created rather than one at a guessed rate |
| Overpaid, no gift card | Red banner in the app, or `syncError` | Feature off, below the minimum, scope missing, or gift cards disabled in Shopify | The banner names which. Scope needs re-authorization |
| Buyer sees "This payment link isn't valid" | — | `PAYMENT_LINK_SECRET` changed, or a truncated URL | Restore the previous secret, or have the buyer reopen from their order confirmation |
| Buyer sees "already being prepared" | `409` from `/api/payram/session` | Two tabs claimed the order at once | Wait 60s and refresh — the claim self-expires |
| Buyer sees "store not connected" | `no offline session for shop` | App installed without an offline grant | Merchant reopens the app in Shopify Admin |
| `/pay` errors on a paid order | `[payram-session]` | — | Expected to show a receipt; if it 500s, check `amountInUsd` exists on the mapping |
| Underpaid orders never resolve | Order stays `payram_partially_paid` | Buyer never returned | The payment link is durable — resend it, or refund what arrived |
| Amounts look wrong on non-USD store | Order note shows the conversion | — | Compare `orderAmount`, `fxRate` and `amountInUsd` on `PaymentMapping`; the rate is the one struck at invoice time, deliberately not today's |

### Health checks

```bash
npm test          # 99 tests: conversion, settlement, top-ups, tolerance, tokens
npm run build     # Remix build
npx prisma migrate deploy   # applies pending migrations (also run by scripts/start.sh)
```

The app's Settings page has **Test Payram Server** and **Create Test Payment Link** buttons
that exercise connectivity and the payment API with the saved credentials.

### Known-open security items

`state/malicious-flows.md` is the registry. Two entries are **open** and deliberately
documented rather than quietly carried:

- **MF-003** — the entry route is unauthenticated, so a guessed order ID can trigger payment
  creation. The signed token makes the resulting link tamper-proof but does not make orders
  unenumerable.
- **MF-004** — Payram webhooks are unsigned. Mitigated by re-reading every payment from
  Payram and refusing to move money on anything unverified.

---

## Database Models

### `MerchantConfig`

| Field | Description |
|-------|-------------|
| `shop` | Unique myshopify.com domain |
| `payramBaseUrl` | Payram API base URL |
| `payramProjectApiKeyEncrypted` | AES-256-GCM encrypted API key |
| `paymentMethodName` | Label shown in checkout |

### `PaymentMapping`

| Field | Description |
|-------|-------------|
| `shop` + `shopifyOrderId` | Composite unique key |
| `payramReferenceId` | Payram reference returned by API |
| `payramCheckoutUrl` | Direct Payram checkout link |
| `payramStatus` | Latest status from Payram |
| `shopifyFinancialStatus` | Synced from Shopify after mark-paid |
| `shopifyPaidSyncedAt` | Timestamp of successful sync |
| `syncError` | Error from last Shopify sync attempt |
| `orderCurrency` | Presentment currency of the Shopify order, e.g. `EUR` |
| `orderAmount` | Original order total in `orderCurrency`, as a decimal string |
| `fxRate` | USD per 1 unit of `orderCurrency` at the time of payment |
| `fxSource` | Where the rate came from, e.g. `open.er-api.com` (`identity` for USD) |
| `amountInUsd` | Converted total actually sent to Payram |

Money is stored as `TEXT`, not `DECIMAL`: SQLite's NUMERIC affinity can silently demote decimal
values to floating point, and PayRam never represents money as a float. Arithmetic is done with
`Prisma.Decimal`.

### `FxRate`

One cached fiat→USD rate per currency — the equivalent of the WooCommerce connector's one-hour WP
transient, DB-backed so it survives restarts.

| Field | Description |
|-------|-------------|
| `currency` | ISO-4217 code, primary key |
| `usdPerUnit` | USD value of one unit, as a decimal string |
| `source` | Rate provider |
| `fetchedAt` / `expiresAt` | Cache window (1 hour) |

---

## Extension Summary

| File | Purpose |
|------|---------|
| `extensions/thank-you-block/src/Checkout.tsx` | UI extension — Preact component for the Thank You block |
| `extensions/thank-you-block/shopify.extension.toml` | Extension config — target, settings field |
| `extensions/thank-you-block/package.json` | `@shopify/ui-extensions@2026.1.3` + `preact` |
| `extensions/thank-you-block/tsconfig.json` | `jsxImportSource: preact`, `moduleResolution: Bundler` |

### How the extension reads order data

```typescript
// Order ID (numeric) from GID
const orderId = shopify.orderConfirmation.value.order.id.split("/").pop();

// Order total — DISPLAY ONLY, never sent to the server.
// useTotalAmount() returns a Money object; the currencyCode matters as much as
// the amount. The server reads the real total from the Admin API instead.
const { amount, currencyCode } = useTotalAmount();

// Email — PCD Level 2 gated, may be undefined
const email = shopify.buyerIdentity?.email?.value;

// App backend URL from extension settings (set in checkout editor)
const appBackendBaseUrl = shopify.settings.value.appBackendBaseUrl;
```

---

## Known Limitations (Development)

### Cloudflare tunnel URL changes on restart

`shopify app dev` creates a new tunnel URL on every start. After restarting:
1. Copy the new URL from the terminal output.
2. Update `SHOPIFY_APP_URL` in `.env`.
3. In the checkout editor → Payram block settings → update **App backend base URL**.

### Protected Customer Data (PCD) limitations

Some customer-data fields require Shopify PCD approval (granted during public app review,
not available in dev stores). The connector degrades rather than failing:

| Feature | Status | Degraded behaviour |
|---|---|---|
| `buyerIdentity.email` in the extension | PCD Level 2 — `undefined` in dev | Email is collected by a text field in the block instead |
| `order.customer` in the settlement lookup | PCD-gated | Retries the query without the field. Tags and notes still apply; a gift card is created but Shopify cannot email it, and the order note says to send it from Admin |
| Order email via Admin REST | PCD-gated | Not used |

`customerEmail` is optional when calling Payram, so a missing email never blocks a payment.

**The connector does not use `orderMarkAsPaid`.** It is PCD-gated and would fail on exactly
the stores that need it, so settlement records state as order **tags and notes**
(`payram_paid`, `payram_partially_paid`, `payram_overpaid`) which work on every plan. This
is deliberate, not a workaround pending approval: the connector never claims Shopify's own
financial status for an off-platform payment it cannot prove to Shopify.

---

## Encryption

Merchant Payram API keys are stored AES-256-GCM encrypted in SQLite.

- Key material: `ENCRYPTION_KEY` env var (64 hex chars = 32 bytes).
- Wire format: `base64(IV[12] + AuthTag[16] + Ciphertext)`.
- The key is never logged or exposed to the browser.
- For production: store `ENCRYPTION_KEY` in a secrets manager (AWS Secrets Manager, GCP Secret Manager, etc.) and inject it as an env var at runtime.

---

## Before App Store Submission

- [ ] Implement CUSTOMERS_DATA_REQUEST webhook handler.
- [ ] Implement CUSTOMERS_REDACT webhook handler (anonymise email in PaymentMapping).
- [ ] Add Payram webhook signature verification.
- [ ] Add rate limiting to `/api/payram/redirect-to-payment` (per IP at reverse proxy).
- [ ] Request PCD Level 2 via Shopify Partner Dashboard.
- [ ] Rotate `ENCRYPTION_KEY` to a KMS-managed key.
- [ ] Replace SQLite with Postgres for production.
