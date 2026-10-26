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

**What this is.** A [React Router](https://reactrouter.com) 7 app on Shopify's
`@shopify/shopify-app-react-router` (Node ≥ 26.12.1, Prisma + SQLite, Admin API 2026-10) sitting
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
| Nothing responds — 404 on every URL | `curl https://YOUR_DOMAIN/healthz` **first**. A 404 there means the hostname is not reaching this container at all, so no amount of app config will help — see [Diagnostics](#symptom--cause--fix) |
| Update an existing install | [Updating](#updating) |
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
4. **Nothing in a Payram webhook body is believed.** Older Payram releases do not sign it,
   and the `customer_id` it is matched on is in the buyer's own payment link. Only figures
   Payram itself confirms — the reference exists *and* belongs to that order — may count as
   money received, tag or note an order, mark it paid, or mint a gift card. An unconfirmed
   message changes nothing but a note telling the merchant what happened.
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

1. Check that Docker is installed, running, and usable by you. It does **not** install Docker for
   you. On Linux, a user outside the `docker` group is told so (and how to fix it) rather than
   told that Docker is down.
2. Ask for an install directory (default: `~/payram-shopify-connector`).
3. Ask for your server's public HTTPS URL.
4. Print a **Shopify login link** and a verification code — open the link in any browser. The
   installer then creates (or reuses) the Shopify app under your Partner account and saves its
   credentials itself. You never copy an API key or secret by hand. The login is kept in a Docker
   volume, so a re-run does not ask again until it expires.
5. Ask for your store domain.
6. Generate an encryption key and a payment-link secret with `openssl` (kept on re-runs — back
   them up). The database is SQLite in the `payram-shopify-data` volume; back that up too.
7. Pull `payramapp/payram-shopify:latest` and print the connector version it contains, deploy the
   checkout block with your server URL built in, show a summary of what is about to run, and start
   the container, published on `127.0.0.1:2798` only.

Paste what you have: the store question accepts the admin URL (`admin.shopify.com/store/<handle>`)
or the storefront URL and works out the `.myshopify.com` address; a custom domain is refused,
because Shopify's install flow only accepts the permanent address. The URL question refuses a path
(the connector owns a whole hostname). `--help` lists the flags and every environment override.

#### Running it unattended (CI, an AI agent)

Every question has an environment override — `PAYRAM_INSTALL_DIR`, `SHOPIFY_APP_URL`,
`SHOPIFY_STORE_DOMAIN` — and a question with nobody to answer it takes its default or stops with
the name of the variable to set. Colours are off when the output is not a terminal. Two things
cannot be automated away:

- **A first install needs either a terminal or a Client ID.** The Shopify CLI asks which
  organisation to use and whether to create the app, and nothing can answer that for you. Either
  run the first install from a terminal, or create the app in the Partner Dashboard yourself and
  pass its Client ID as `SHOPIFY_API_KEY`; the installer then fetches the secret itself.
- **The Shopify login is done by a person.** When it is needed, the output contains
  `Open this link to start the auth process:` followed by the link and a verification code. Whoever
  supervises the run opens it; the installer waits.

On a re-run, values already in `.env` win over the environment — edit `.env` to change them. A
hand-edited `.env` with Windows line endings or quoted values is normalised first and the run says
so: Docker's `--env-file` would otherwise pass the `\r` or the quotes into the container as part of
the value.

Three settings are never asked and live only in `.env`: `CONNECTOR_IMAGE` pins the image to a tag or
`@sha256` digest instead of following `:latest` (set it in the environment on the first run and it
is written to `.env`; delete the line to follow `:latest` again), `CONNECTOR_BIND_ADDRESS` chooses
where port 2798 is published, and `PORT` changes the port itself (read from `.env` only — a `PORT`
exported by a CI runner is ignored).

---

### Step 2 — The checkout block is deployed for you

The installer deploys the checkout extension as part of Step 1, with your server URL written into
it. There is nothing to do here.

> **Don't run `shopify app deploy` straight from the image.** The published image contains
> placeholders — `__PAYRAM_REDIRECT_BASE_URL__` in the block and `{{ CLIENT_ID }}` in the app
> config — that only the installer fills in. Deploying without them ships a block that shows
> *"Payment link is not configured yet"*. To redeploy, re-run the installer
> (see [Updating](#updating)).

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

> **Live store?** A development store installs straight away. For a live store, first open the
> Partner Dashboard → Apps → *payram-checkout-plugin* → **Distribution**, choose **Custom
> distribution** and enter your store's `.myshopify.com` domain. Shopify refuses to install an
> app with no distribution on a live store, and the error it shows does not say why.

---

### Step 5 — Configure Payram credentials

1. Open **Shopify Admin → Apps** and open the Payram app.
2. Enter:
   - **Payram Base URL** — your own Payram server, e.g. `https://payram.your-domain.com`
   - **Payram Project API Key** — from your Payram dashboard
3. Click **Save Settings**, then **Test Payram Server** and **Create Test Payment Link** to confirm
   both the connection and the payment API work.

---

### Step 5b — Point Payram's webhook at the connector

**Do not skip this.** Without it the connector is never told that a payment
arrived: the buyer pays, Payram shows the payment, and the Shopify order sits
unpaid and untagged forever.

In your **Payram dashboard**, open the project used for this store, go to
**Webhooks**, and add:

```
https://YOUR_DOMAIN/api/payram/webhook
```

Use Payram's **Test webhook delivery** to confirm it arrives. From the server
side you can watch for it:

```bash
docker logs -f payram-shopify-connector | grep payram-webhook
```

> Payram queues a delivery only for webhooks that exist **at the moment a payment
> is processed**. Adding the webhook later does not back-fill past payments —
> settle those with **Re-check payment** in the app.

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
4. Click **Save**.

There is nothing to configure on the block — the installer already built your server URL into it.

---

### Step 8 — Test end-to-end

1. Go to your store and place an order using the *Pay with Crypto via Payram* payment method.
2. On the Thank You page the Payram block shows the order total with its currency.
3. Enter an email address (required — it's where Payram sends the receipt) and click
   **Continue to crypto payment**.
4. The payment page opens in the same tab, confirms the total and the exchange rate, then takes you
   to your Payram checkout.

---

### Step 9 — Choose how partial and overpayments are handled

Crypto payments don't always arrive as the exact amount. In the Payram app you can set:

- **Underpayment tolerance** — how far short a payment can be and still count as paid
  (default 1%, at least $1).
- **Refund overpayments as a gift card** — **off by default**. Turning it on needs gift cards
  enabled in Shopify.

What each setting does, and what the connector does automatically, is explained in
[Partial and Overpayments](#partial-and-overpayments).

---

## Configuration Reference

Configuration lives in three places. An agent changing behaviour should know which.

### 1. Environment (server)

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_API_KEY` | ✅ | Shopify app Client ID |
| `SHOPIFY_API_SECRET` | ✅ | Shopify app Client secret. Also the fallback signer for payment links |
| `SHOPIFY_APP_URL` | ✅ | Public HTTPS URL of this server. Used to build absolute redirects for App Proxy requests |
| `DATABASE_URL` | ✅ | SQLite only: `file:/data/prod.sqlite` in Docker (the installer sets it). The image's Prisma client is built for SQLite; a Postgres URL fails at startup |
| `ENCRYPTION_KEY` | ✅ | 64-char hex key encrypting stored Payram API keys (AES-256-GCM). The installer generates it and refuses to start a container whose `.env` holds anything else — the app would only fail at the first Settings save |
| `SCOPES` | ✅ | `read_orders,write_orders,read_customers,write_customers,write_app_proxy,write_gift_cards` (do not change) |
| `PAYMENT_LINK_SECRET` | **production** | Signs `/pay/{token}` links. The installer generates it; set it yourself on a manual install — see the warning below |
| `PORT` | — | Server port (default `2798`). The installer publishes and probes the same number; it reads this from `.env` only |
| `CONNECTOR_BIND_ADDRESS` | — | Installer only. How the port is published: an address (`127.0.0.1` on new installs), `all` (every interface, IPv4+IPv6) or `none` (Docker networks only). A re-run keeps whatever the existing container had |
| `CONNECTOR_IMAGE` | — | Installer only. Image to run instead of `payramapp/payram-shopify:latest` — a release tag such as `1.2.0`, a `sha-<commit>` tag (no version, so no update notices) or an `@sha256` digest. Set in the environment on a first run it is written here; remove the line to follow `:latest` again |
| `PAYRAM_BASE_URL` / `PAYRAM_PROJECT_API_KEY` | — | Dev shortcut to skip the Settings page. Per-shop DB config wins |
| `ALLOW_INSECURE_PAYRAM_URL` | — | Dev only. Disables SSRF protection on the Payram URL. **Never set in production** |

> **Set `PAYMENT_LINK_SECRET` explicitly in production.** Without it, links are signed with
> `SHOPIFY_API_SECRET`, so rotating your Shopify credentials invalidates *every outstanding
> payment link* — including links held by buyers who have already part-paid. The installer
> does this for you: a fresh install gets a random secret, and an upgrade of an install that
> never had one pins it to the Shopify secret the outstanding links were already signed with.

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
| Underpayment tolerance (%) | `1.0` | Shortfall that still counts as paid, as a share of the order. Maximum `10` |
| Minimum tolerance (USD) | `1.00` | Floor for small orders. The **larger** of the two applies |
| Refund overpayments as a gift card | `off` | Needs gift cards enabled in Shopify and the `write_gift_cards` + `write_customers` permissions |
| Minimum overpayment to refund (USD) | `1.00` | Smaller excess is noted on the order, not refunded |

Effective tolerance is `max(invoice × percent, floor)` — proportional because network fees
and price drift scale with order size. A $1,000 order allows $10; a $20 order allows $1.

### 3. Shopify-side prerequisites

- A **manual payment method** named to match the setting above.
- The **Payram Thank You Block** added in the checkout editor.
- **A Payram webhook** pointing at `https://YOUR_DOMAIN/api/payram/webhook`, configured in the
  Payram dashboard. Without it no payment is ever settled.
- **Gift cards enabled** (Settings → Gift cards) if refunding overpayments.
- **Up-to-date permissions.** When the permission list changes, re-run the installer so the app is
  redeployed with the new list, then open the app in Shopify Admin and approve. Reopening the app
  alone is not enough — it can only request what the deployed app declares.

---

## Updating

Updates happen **on your server**, not from the Shopify App Store — this is your own app, so
Shopify has nothing to push. Every merge to `main` publishes a new image automatically.

### Recommended: re-run the installer

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/PayRam/payram-shopify/main/setup_payram_shopify.sh)"
```

- Press Enter to keep the **same install directory**. A different directory is treated as a brand
  new install: new encryption key, new Shopify app, and your saved Payram API key is lost.
- Accept your existing values when asked. If a Shopify login link appears, open it.
- **Never pass `--reset`** — that deletes the container, data volume and configuration.

It pulls the latest image (or the one pinned by `CONNECTOR_IMAGE` in `.env`), redeploys the
checkout block and app permissions, and replaces the container. The old container is kept until
the new one has been created: if Docker refuses the new one — the port taken, a bad line in
`.env` — the old one is put back and started, and the run says why. Settings, the saved API key
and payment history live in the `payram-shopify-data` volume and carry over; database migrations
run on start.

Afterwards, open the app in Shopify Admin and approve any new permissions.

**Use this path whenever a release changes the checkout block or the permission list** — the server
commands below do not touch either.

### Server only

For releases that change only server code:

```bash
docker pull payramapp/payram-shopify:latest
docker port payram-shopify-connector 2798     # note the address — reuse it in -p below
docker stop payram-shopify-connector && docker rm payram-shopify-connector
docker run -d \
  --name payram-shopify-connector \
  --env-file ~/payram-shopify-connector/.env \
  -p 127.0.0.1:2798:2798 \
  -v payram-shopify-data:/data \
  --restart unless-stopped \
  payramapp/payram-shopify:latest
```

**Keep the binding your container already has.** New installs use `127.0.0.1` so only the
reverse proxy or tunnel on this host can reach the connector. If `docker port` showed
`0.0.0.0`, use a bare `-p 2798:2798` (an explicit `0.0.0.0` would drop IPv6). If it showed
nothing, the connector is reached over a Docker network: omit `-p` and re-run
`docker network connect <network> payram-shopify-connector` afterwards. Re-running the
installer does all of this for you and records the result as `CONNECTOR_BIND_ADDRESS` in `.env`.

### Check which version you're running

```bash
docker inspect payram-shopify-connector \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

This prints the commit the running image was built from. The installer prints the connector
version and image digest right after the pull, and the app's Settings page shows the running
version — which is also what lets it tell you when a newer release exists.

How the image tags relate:

| Tag | What it is | Carries a version (Settings page, update notices) |
|---|---|---|
| `latest` | What the installer pulls. Follows `main`; once a release is tagged there, it is that release's own build | Yes once the release is tagged; a `main` commit not yet tagged carries none |
| `<version>`, e.g. `1.2.0`, and `1.2` | A release build | Yes |
| `sha-<commit>` | The build of one `main` commit, never replaced | No — the page shows no version and no update notice |

Re-running an older release's build never moves `latest` back. To stay on one release, put
`CONNECTOR_IMAGE=payramapp/payram-shopify:<version>` (or its `@sha256` digest) in `.env` and
re-run the installer; `sha-<commit>` pins one exact build too, but without update notices.

> **Installed before May 11, 2026?** Early installers pulled `mason0816/payram-shopify-test`.
> Re-running the installer moves you to `payramapp/payram-shopify`.

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

This starts the React Router dev server, creates a Cloudflare tunnel, and streams logs.

### 5. Configure Payram credentials in the app

1. Open the app in Shopify Admin (follow the install URL from the terminal).
2. On the **Settings** page enter:
   - **Payram Base URL** — your Payram server, e.g. `https://payram.your-domain.com`
   - **Payram Project API Key**
3. Click **Save Settings**.
4. Click **Test Payram Server** and **Create Test Payment Link** to verify.

### 6. Add the manual payment method in Shopify

In Shopify Admin → Settings → Payments → Manual payment methods:

```
Pay with Crypto via Payram
```

### 7. Add the Payram block to the Thank You page

1. In Shopify Admin → Online Store → Checkout → Customize.
2. Navigate to the **Thank You** page.
3. Add the **Payram Thank You Block** from the extension list.
4. Save.

The block has no settings. Its server URL is a build-time placeholder that the installer fills in,
so in local dev you fill it in yourself: replace `__PAYRAM_REDIRECT_BASE_URL__` in
`extensions/thank-you-block/src/Checkout.tsx` with your current tunnel URL
(e.g. `https://xyz.trycloudflare.com`). **Don't commit that change.**

> **Important:** The tunnel URL changes every time you restart `shopify app dev`, so update the
> placeholder replacement each time.

### 8. Place a test order

1. Go to your development store → place an order using the manual payment method.
2. On the Thank You page the Payram block appears.
3. Enter an email address — without a valid one, clicking the button shows an error instead of continuing.
4. Click **Continue to crypto payment** — the payment page opens, then redirects to Payram.

---

## Backend Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Liveness + identity. Returns `{"app":"payram-shopify-connector","ok":true}`. No auth, no database, no version — use it to prove a hostname reaches *this* container |
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

payram-core's payment webhook (`SendWebhookToMerchant`); snake_case and camelCase field names
are both accepted:

```json
{
  "customer_id": "shopify:{shop}:order:{orderId}",
  "reference_id": "payram-ref-id",
  "status": "OPEN | FILLED | PARTIALLY_FILLED | OVER_FILLED | CANCELLED",
  "filled_amount_in_usd": "40.00"
}
```

The body only says **which reference to ask Payram about**. Its amounts are never recorded:

1. **Signature.** payram-core 3.9.0+ sends `X-Payram-Signature: sha256=<HMAC-SHA256 of the raw
   body, keyed with the project API key>`. Once a shop has received one correctly signed with
   its saved key, unsigned or wrongly signed webhooks are refused before anything is recorded.
   Shops whose Payram does not sign yet keep working — step 2 still guards them.
2. **Confirmation.** The reference is read from Payram (`GET /api/v1/payment/reference/{id}`).
   Only if Payram confirms it belongs to this order are Payram's figures recorded and settled.

| Response | When | Payram then |
|---|---|---|
| `200` | Handled, or deliberately ignored (no such order, unrecognised status, Payram does not confirm the reference) | stops |
| `401` | Refused by the signature check | resends — succeeds once the right API key is saved |
| `503` | Payram could not be asked (unreachable, 5xx, not configured) — nothing recorded | resends |
| `500` | Settlement failed on the Shopify side | resends |

payram-core resends anything that is not 2xx: three quick attempts, then 30 min, 1 h, 2 h,
4 h, 8 h, 24 h and 48 h, after which the delivery is marked failed. **Re-check payment** covers
anything that never arrived.

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

### When a payment counts

- **Only after Payram confirms it on-chain.** While a deposit is still collecting confirmations the
  order is left untouched; it is updated once Payram reports the payment as received.
- **Only what Payram confirms for this order.** Every amount is read from Payram itself, never
  from the webhook message. Payments recorded by versions before 2026-10-22 count once Payram
  confirms them — checked automatically the next time the order settles or the buyer opens their
  payment link, or straight away with **Re-check payment**.
- **Everything is added up.** A buyer can pay in more than one go — every payment made for the
  order counts toward its total.
- **Within tolerance is paid.** A shortfall or excess smaller than the tolerance —
  `max(order × percent, floor)`, default `max(1%, $1)`, capped at 10% — is treated as an exact
  payment. Nothing is flagged and nothing is refunded.
- **Amounts are fixed at invoice time.** The order total is converted to USD when the buyer opens
  the payment, and that rate is stored on the order. Balances are always shown at that rate.

### What happens automatically

| Situation | Order tags | Order note | Money | Fulfil? |
|---|---|---|---|---|
| Paid in full (within tolerance) | `payram_paid` | "paid in full" | — | Yes |
| **Underpaid** | `payram_partially_paid` | "Still due €13.11 — do not fulfil" | none moved | **No** |
| **Overpaid** | `payram_paid` + `payram_overpaid` | excess recorded | gift card for the excess, *if turned on* | Yes |

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

### Overpayment refund rules

- **The order is filled first.** Only the amount *above* the invoice is refunded — never the whole
  payment. This also applies when extra funds arrive after the order was already paid.
- **At most one automatic gift card per order.** If more money arrives after a card was issued, no
  second card is created; the app tells you the extra amount to refund yourself.
- **Only confirmed payments are refunded.** If the connector cannot confirm the payment with Payram,
  no card is issued and you are asked to refund manually.
- **Small excesses are kept on record, not refunded.** Anything below *Minimum overpayment to
  refund* (default $1) is noted on the order.
- **Issued in your store's currency.** Converted at the order's stored rate when the order was in
  that currency, otherwise at a live rate.
- **Delivered by Shopify** *when the app can read the order's customer*. The card is attached to
  that customer and Shopify emails it. If the order has no customer, or Protected Customer Data
  restrictions hide it from the app, the card is still created but nobody is emailed — the order
  note says so, and you send it from Shopify Admin → *Gift cards*.
- **The order stays paid if refunding fails.** A failed card is recorded as a warning; the order is
  still tagged paid and can be fulfilled.
- **The full card code is never stored** by the connector — only the card's ID and last characters.
  Shopify keeps the code.

### Merchant setup

Gift card refunds are **off by default**, because they move money. To turn them on:

1. **Enable gift cards in Shopify** — Settings → *Gift cards*. Without this, card creation is
   rejected and a warning is recorded on the order instead.
2. **Make sure the app has permission.** Refunds need the `write_gift_cards` scope, and
   `write_customers` so the card can be attached to the buyer and emailed. Installs from before
   September 17, 2026 do not declare them: [re-run the installer](#updating), then open the app in
   Shopify Admin and approve.
3. **Turn it on** — in the Payram app, tick *Refund overpayments as a gift card*, set the minimum,
   and save.

If anything is missing, the app shows a red warning at the top of its page saying which.

Underpayment tolerance needs no setup — it is on by default at 1% / $1. Change it in the same
settings page (maximum 10%).

### Merchant operations

**Underpaid order**
1. The order appears tagged `payram_partially_paid` with the shortfall in the note, in USD and in
   the order's currency.
2. Do not fulfil.
3. The buyer pays the balance from their **payment link** — the page opened from the Thank You
   block. It shows what is still owed with a button to pay it, and asks the buyer to bookmark it.
   When the rest arrives the order is re-tagged `payram_paid` automatically.
4. If the buyer doesn't return, contact them, or refund what was received and cancel the order.

> **Known gap:** the app cannot yet show or resend a buyer's payment link. A buyer who loses it
> cannot currently be sent a new one from the admin.

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

> **Security note.** A webhook message is never trusted for money. The connector re-reads every
> payment from Payram (`GET /api/v1/payment/reference/{id}`) and acts only on what Payram confirms
> belongs to the order; anything else is ignored and noted on the order. A forged webhook cannot add
> to what an order has received, mark it paid, or mint value. See `state/malicious-flows.md`
> (MF-008, MF-012, MF-013).

---

## Where the connector sits on your server

The connector is a separate container listening on **2798**, published on `127.0.0.1` only,
so the proxy or tunnel is the only way in. Something must terminate HTTPS for its hostname
and forward to it. That is not optional and the installer does not do it — it is the one
piece that depends on how your server is already arranged.

**The one rule:** exactly one process owns ports 80 and 443 and routes by hostname.

```
            Internet
                │
        :80 / :443  ──────────────  ONE front door (routes by Host header)
                │                   terminates TLS for BOTH hostnames
       ┌────────┴────────┐
       │                 │
  pay.example.com   shopify.example.com
       │                 │
  Payram container   Connector container
  (loopback only)    127.0.0.1:2798
```

### If Payram runs on the same server

Payram's container publishes 80/443 and its bundled nginx is a **catch-all** —
`listen ... default_server` with `server_name _`, and no `conf.d` include. It answers for
any hostname you point at the server, which is why a new subdomain silently serves the
Payram dashboard instead of the connector.

Two consequences:

- **There is no supported place inside that container to add a virtual host.** Its config is
  baked into the image and replaced on every Payram upgrade.
- **A host-level nginx block will not help on its own** — port 443 is already taken, and on
  many installs there is no nginx on the host at all.

Workable topologies, in rough order of robustness:

| Approach | Payram container restart? | Survives a Payram upgrade | Notes |
|---|---|---|---|
| **Containerised proxy** (Caddy / nginx / Traefik on 80/443, both apps on a shared Docker network, no published ports) | Yes — re-created without `-p 80`/`-p 443` | Yes, routing is in your own config | Most robust. Caddy also handles certificates for both hostnames. The connector's port is loopback-only on the host, so attach it to the proxy's network (`docker network connect <net> payram-shopify-connector`) and proxy to `http://payram-shopify-connector:2798` |
| **Host proxy** (Caddy or nginx + certbot on 80/443) | Yes — same reason | Yes | Familiar; Caddy needs the least certificate work |
| **Tunnel for the connector only** (e.g. Cloudflare Tunnel → `http://localhost:2798`) | **No** | Yes | Leaves Payram untouched and needs no host ports, but your DNS must be on that provider |

Two things that look like solutions and are not:

- **Editing nginx inside the Payram container** — lost on the next upgrade.
- **Path-prefix routing** (serving the connector under `/shopify/`) — the connector serves
  absolute paths (`/app`, `/pay/...`, `/auth`, `/api/payram/...`) and has no base-path
  setting, so it breaks.

Note that Payram's apex sends `Strict-Transport-Security` with `includeSubDomains`, so
browsers force HTTPS on every subdomain. An HTTP-only connector hostname cannot work, even
temporarily.

### Working it out on a server you did not set up

[`docs/REVERSE-PROXY-DIAGNOSTIC-PROMPT.md`](docs/REVERSE-PROXY-DIAGNOSTIC-PROMPT.md) is a
prompt to paste into any AI assistant. It is deliberately **discovery-first**: it runs a
read-only inventory of ports, containers, certificates and DNS, prints what it actually
found, and is instructed not to suggest a change until that inventory is confirmed. It also
captures the Payram container's configuration before anything is restarted.

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
| **Every connector URL 404s** — the install link, `/pay/...`, the webhook | `curl https://YOUR_DOMAIN/healthz` returns someone else's page, while `curl http://127.0.0.1:2798/healthz` on the server works | **The hostname never reaches the container.** Whatever owns port 443 is answering for it. If Payram runs on the same server, that is Payram's bundled nginx — a deliberate catch-all (`server_name _`) that answers for *every* hostname, so buyers get the dashboard's 404, not the connector's | You need one front door that routes by hostname — see [Where the connector sits on your server](#where-the-connector-sits-on-your-server). Re-running the installer detects which case you are in and prints the right fix. A **502** instead means routing is right and the container is down |
| Installer says *"Docker is running, but this user is not allowed to use it"* | `docker info` → `permission denied … docker.sock` | Linux default: only root and the `docker` group may use the socket | `sudo usermod -aG docker $USER`, log out and in, re-run. Or run the installer with `sudo` every time — then the install directory is root's |
| Shopify shows an error page when opening the install link | the link ends in `?shop=<your custom domain>` | `SHOPIFY_STORE_DOMAIN` is a storefront domain; Shopify's install flow accepts only `<handle>.myshopify.com` | Re-run the installer — it now refuses the stored value and asks again; paste your admin URL |
| Orders never tagged paid, nothing in the logs | no `[payram-webhook]` lines at all | **No webhook configured in Payram**, or it points at the wrong URL | Add it (see [Step 5b](#step-5b--point-payrams-webhook-at-the-connector)), then use **Re-check payment** for orders already paid |
| Orders never tagged paid | `[payram-webhook] received` present, no tag | Webhook status not recognised, or Payram did not confirm the reference for this order | Check the `syncError` on the order; confirm the payment in Payram, then **Re-check payment** |
| Payram's webhook log shows `401` from the connector | `[payram-webhook] refused` | The store's Payram signs its webhooks, and this one was not signed with the API key saved in the app — usually a new API key created in Payram | Save the project's current API key in the app's settings; Payram resends on its own |
| Payram's webhook log shows `503` from the connector | `[payram-verify] … request failed` | The connector could not reach Payram to confirm the payment | Check the Payram Base URL and that Payram is reachable from the connector; Payram resends on its own |
| Order tagged `payram_paid` but Shopify says "Payment pending" | warning on the order in the app | `orderMarkAsPaid` was refused — usually the installing staff member lacks *mark orders as paid* | Grant that permission and press **Re-check payment**, or use Shopify's own **Mark as paid** |
| Buyer sees "Exchange rate unavailable" | `[payram-fx] rate provider unreachable` | No egress to `open.er-api.com` | Allow outbound HTTPS. **Never** bypass — no payment is created rather than one at a guessed rate |
| Overpaid, no gift card | Red banner in the app, or `syncError` | Feature off, below the minimum, payment not confirmed with Payram, a card already issued for this order, permissions missing, or gift cards disabled in Shopify | The banner or note names which. Missing permissions: re-run the installer, then approve in Shopify Admin |
| Buyer sees "This payment link isn't valid" | — | `PAYMENT_LINK_SECRET` changed, or a truncated URL | Restore the previous secret, or have the buyer reopen from their order confirmation |
| Buyer sees "already being prepared" | `409` from `/api/payram/session` | Two tabs claimed the order at once | Wait 60s and refresh — the claim self-expires |
| Buyer sees "store not connected" | `no offline session for shop` | App installed without an offline grant | Merchant reopens the app in Shopify Admin |
| Block says "Payment link is not configured yet" | — | Extension deployed without the installer, so the server URL placeholder was never filled in | Re-run the installer |
| `/pay` errors on a paid order | `[payram-session]` | — | Expected to show a receipt; if it 500s, check `amountInUsd` exists on the mapping |
| Underpaid orders never resolve | Order stays `payram_partially_paid` | Buyer never returned to their payment link | Contact the buyer, or refund what arrived. The admin can't resend the link yet |
| Amounts look wrong on non-USD store | Order note shows the conversion | — | Compare `orderAmount`, `fxRate` and `amountInUsd` on `PaymentMapping`; the rate is the one struck at invoice time, deliberately not today's |

### Health checks

```bash
# Is the hostname Shopify calls actually reaching this container?
curl https://YOUR_DOMAIN/healthz      # => {"app":"payram-shopify-connector","ok":true}
curl http://127.0.0.1:2798/healthz    # same, run on the server itself

npm test          # unit tests: conversion, settlement, top-ups, tolerance, tokens
npm run build     # React Router build
npx prisma migrate deploy   # applies pending migrations (also run by scripts/start.sh)
```

If the second command answers and the first does not, the container is healthy and the
problem is your reverse proxy — not the connector. Anything other than that exact JSON
from the public URL means the request is being served by a different application.

The app's Settings page has **Test Payram Server** and **Create Test Payment Link** buttons
that exercise connectivity and the payment API with the saved credentials.

### Known-open security items

`state/malicious-flows.md` is the registry. Two entries are **open** and deliberately
documented rather than quietly carried:

- **MF-003** — the entry route is unauthenticated, so a guessed order ID can trigger payment
  creation. The signed token makes the resulting link tamper-proof but does not make orders
  unenumerable.
- **MF-004 / MF-013** — Payram releases before 3.9.0 do not sign webhooks. Signatures are
  enforced per shop once its Payram is seen signing; independently, nothing in a webhook counts
  until Payram confirms it for the order (MF-012).

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
| `extensions/thank-you-block/shopify.extension.toml` | Extension config — target only. The block has no merchant settings |
| `extensions/thank-you-block/package.json` | `@shopify/ui-extensions@2026.10.2` + `preact` (checkout extension API 2026-10) |
| `extensions/thank-you-block/tsconfig.json` | `jsxImportSource: preact`, `moduleResolution: Bundler` |

### How the extension reads order data

```typescript
// Order ID (numeric) from the order confirmation GID
const api = useApi<"purchase.thank-you.block.render">();
const orderId = (api.orderConfirmation.value?.order?.id ?? "").split("/").pop();

// Order total — DISPLAY ONLY, never sent to the server.
// useTotalAmount() returns a Money object; the currencyCode matters as much as
// the amount. The server reads the real total from the Admin API instead.
const totalAmount = useTotalAmount();

// Shop domain, sent so the server knows which store the order belongs to
const shopDomain = useShop().myshopifyDomain;

// Email — typed into a text field in the block. buyerIdentity.email is
// PCD-gated and not relied on.

// Server URL — a build-time placeholder the installer replaces before deploy.
// There is no block setting for it.
const redirectBaseUrl = "__PAYRAM_REDIRECT_BASE_URL__";
```

---

## Known Limitations (Development)

### Cloudflare tunnel URL changes on restart

`shopify app dev` creates a new tunnel URL on every start. After restarting:
1. Copy the new URL from the terminal output.
2. Update `SHOPIFY_APP_URL` in `.env`.
3. Replace the URL in `extensions/thank-you-block/src/Checkout.tsx` (where
   `__PAYRAM_REDIRECT_BASE_URL__` was) with the new tunnel URL. Don't commit it.

### Protected Customer Data (PCD) limitations

Some customer-data fields require Shopify PCD approval (granted during public app review,
not available in dev stores). The connector degrades rather than failing:

| Feature | Status | Degraded behaviour |
|---|---|---|
| `buyerIdentity.email` in the extension | PCD Level 2 — `undefined` in dev | Email is collected by a text field in the block instead |
| `order.customer` in the settlement lookup | PCD-gated | Retries the query without the field. Tags, notes and marking paid still apply; a gift card is created but Shopify cannot email it, and the order note says to send it from Admin |
| Order email via Admin REST | PCD-gated | Not used |

`customerEmail` is optional when calling Payram, so a missing email never blocks a payment.

**The connector marks settled orders paid** with `orderMarkAsPaid`, and keeps the tags
(`payram_paid`, `payram_partially_paid`, `payram_overpaid`) as the audit trail. Tags alone
were not enough: they are invisible to payouts, order filters, reports and fulfilment apps,
so merchants had to click *Mark as paid* on every crypto order.

Marking paid is **best-effort and deliberately gated**:

- Only payments **confirmed with Payram** for the order can mark it paid. The webhook message is
  not trusted, and setting Shopify's financial status is not reversible through the API, so it
  requires the same trust level as issuing a gift card.
- **Underpaid orders are never marked paid**, and no order is marked twice.
- If Shopify refuses — most often because the staff member who installed the app lacks the
  *mark orders as paid* permission — the order still settles and stays tagged, and the reason
  appears on the order in the app. Use **Re-check payment** after granting the permission.

> An earlier build avoided this mutation, believing it was PCD-gated. Shopify documents it as
> needing `write_orders` plus the staff permission `mark_orders_as_paid`; Protected Customer
> Data governs customer PII, not this mutation.

---

## What the connector sends out

Two outbound calls, both off the merchant's own server, and neither carries store data:

| Call | When | Contains |
|---|---|---|
| `open.er-api.com` | Converting a non-USD order, cached an hour | The currency code only |
| `api.github.com` | Once a day, **only if enabled** | Nothing — an unauthenticated read of the public releases page |

Everything else is between the merchant's server, their own Payram instance and their own
Shopify store.

**Update checks are off by default.** The product's promise is that nothing is reported to
anyone and everything is the business's decision, so the connector does not phone anywhere
until the merchant turns it on under *Check for connector updates*. Enabling it tells GitHub
the server's IP exists, the same as any `docker pull` does — and nothing about the shop,
its orders or its customers. Nothing is ever installed automatically.

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
