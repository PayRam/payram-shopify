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
  payram/shopify-connector:latest \
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
| `SCOPES` | ✅ | `read_orders,write_orders,read_customers` (do not change) |
| `PORT` | — | Server port (default: `3000`) |

---

## Updating

```bash
docker pull payram/shopify-connector:latest
docker stop payram-shopify-connector && docker rm payram-shopify-connector
docker run -d \
  --name payram-shopify-connector \
  --env-file ~/payram-shopify-connector/.env \
  -p 3000:3000 \
  -v payram-shopify-data:/data \
  --restart unless-stopped \
  payram/shopify-connector:latest
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
SCOPES=read_orders,write_orders,read_customers
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
| `GET` | `/api/payram/redirect-to-payment` | Creates Payram payment and redirects buyer |
| `GET` | `/api/payram/status` | Returns PaymentMapping for an order or reference |
| `POST` | `/api/payram/webhook` | Receives Payram payment status webhooks |

### `GET /api/payram/redirect-to-payment`

Query params:

| Param | Required | Description |
|-------|----------|-------------|
| `shopifyOrderId` | Yes | Numeric Shopify order ID |
| `amountInUSD` | Yes | Order total in USD |
| `shop` | Yes | `*.myshopify.com` domain |
| `email` | No | Buyer email for Payram receipt |

Behaviour:
- Validates params, loads merchant Payram config.
- If a mapping already exists for the order, redirects to the existing checkout URL (idempotent).
- Otherwise calls `POST {payramBaseUrl}/api/v1/payment`, stores the mapping, redirects buyer.

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
  "amountInUSD": 50.00,
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

// Amount in USD
const amountInUSD = shopify.cost.totalAmount.value.amount;

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
