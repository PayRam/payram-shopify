# Payram Shopify Connector

Accept crypto payments on your Shopify store via [Payram](https://www.payram.com). The connector adds a **Pay with Crypto** block to the Shopify Thank You page — buyers enter their email, click the button, and are redirected to a Payram-hosted checkout to complete payment in crypto.

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

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_API_KEY` | ✅ | Shopify app Client ID |
| `SHOPIFY_API_SECRET` | ✅ | Shopify app Client secret |
| `SHOPIFY_APP_URL` | ✅ | Public HTTPS URL of this server |
| `DATABASE_URL` | ✅ | SQLite (`file:prod.sqlite`) or Postgres connection string |
| `ENCRYPTION_KEY` | ✅ | 64-char hex key for encrypting stored API keys |
| `SCOPES` | ✅ | `read_orders,write_orders,read_customers,write_app_proxy,write_gift_cards` (do not change) |
| `PORT` | — | Server port (default: `2798`) |

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

## Architecture

```
Shopify Thank You page
  └── Checkout UI Extension (purchase.thank-you.block.render)
        └── buyer enters email → clicks button
              └── GET /api/payram/redirect-to-payment
                    └── create Payram payment via Payram API
                    └── store PaymentMapping in DB
                    └── redirect buyer to Payram checkoutUrl

Payram webhook → POST /api/payram/webhook
  └── update payment status
  └── attempt orderMarkAsPaid in Shopify

Shopify Admin → /app (settings page)
  └── merchant sets Payram Base URL + API Key (encrypted at rest)
```

---

## Architecture

```
Shopify Thank You page
  └── Checkout UI Extension (purchase.thank-you.block.render)
        └── buyer clicks link → GET /api/payram/redirect-to-payment
              └── create Payram payment via POST {payramBaseUrl}/api/v1/payment
              └── store PaymentMapping in SQLite
              └── redirect buyer to Payram checkoutUrl

Payram webhook → POST /api/payram/webhook
  └── update payramStatus
  └── attempt orderMarkAsPaid (PCD-gated, fault-tolerant)

Shopify Admin → /app (settings page)
  └── merchant sets Payram Base URL + API Key (encrypted at rest)
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
SCOPES=read_orders,write_orders,read_customers,write_app_proxy,write_gift_cards
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

Behaviour:
- Validates params, loads merchant Payram config.
- If a mapping already exists for the order, redirects to the existing checkout URL (idempotent).
- Reads the **authoritative order total from the Shopify Admin API** (`read_orders`), never from the
  request. The buyer's browser cannot influence the amount charged.
- Converts that total to USD (see [Currency Handling](#currency-handling)). If no live exchange rate
  is available the payment is **not** created and the buyer is asked to retry.
- Claims the order in the database, calls `POST {payramBaseUrl}/api/v1/payment`, stores the
  reference, and redirects the buyer.

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

The following features require Shopify PCD approval (granted during public app review — not available in dev stores):

| Feature | Status |
|---------|--------|
| `buyerIdentity.email` in extension | PCD Level 2 — returns `undefined` in dev |
| `orderMarkAsPaid` GraphQL mutation | PCD-gated — `syncError` stored, webhook still returns 200 |
| Order email via Admin REST | PCD-gated |

Workarounds implemented:
- Email is collected manually via a text field in the block.
- `customerEmail` is optional when calling Payram.
- `orderMarkAsPaid` failures are stored in `PaymentMapping.syncError` and do not cause webhook retries.

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
