# Malicious Flow Registry — payram-shopify

Severity-tagged registry of abuse paths through the Shopify connector, per
`methodology-core` **R-MALICIOUS-FLOW**. Entries are never deleted; a changed
mitigation is recorded by superseding the entry.

Severity: `low` / `medium` / `high` / `critical`.

---

## MF-001 — Buyer-controlled payment amount

- **Severity:** high
- **Status:** mitigated (2026-09-02)
- **Attack:** The Thank You page extension passed the order total to the server
  as an `amountInUSD` query parameter. The extension navigates directly to the
  app URL, so no Shopify App Proxy `signature` is present, and the route only
  verified a signature when one existed. A buyer could edit the URL and pay any
  amount they chose — `?amountInUSD=1` on a €500 order.
- **Affected surfaces:** `GET /api/payram/redirect-to-payment`,
  `extensions/thank-you-block`.
- **Mitigation:** The amount is no longer accepted from the client. The route
  reads the order total from the Shopify Admin API server-side
  (`fetchOrderTotal`, using the already-granted `read_orders` scope) and any
  `amountInUSD` parameter is ignored. This matches the WooCommerce connector,
  which loads the order server-side in `process_payment($order_id)`.

---

## MF-002 — Currency substitution (non-USD total booked as USD)

- **Severity:** high
- **Status:** mitigated (2026-09-02)
- **Attack:** Not attacker-driven, but the same class of loss and worth tracking
  here: Payram's `POST /api/v1/payment` takes `amountInUSD` literally and
  payram-core has no fiat rates, so a €50 order was created as a $50 payment.
  Every non-USD merchant was silently short-changed by the FX spread on every
  order, and the order was still tagged `payram_paid` because nothing downstream
  compared amounts.
- **Affected surfaces:** `extensions/thank-you-block` (dropped `currencyCode`),
  `app/utils/payram.server.ts`, `PaymentMapping` (stored no amount to reconcile
  against), `api.payram.webhook` (status-only, never amount-aware).
- **Mitigation:** `app/utils/fx.server.ts` converts the presentment total to USD
  before the payment is created and fails closed if no live rate is available.
  The original amount, currency, rate and source are persisted on
  `PaymentMapping` for reconciliation.

---

## MF-003 — Unauthenticated payment creation for arbitrary order IDs

- **Severity:** medium
- **Status:** **pending**
- **Attack:** `GET /api/payram/redirect-to-payment` verifies the App Proxy HMAC
  only when a `signature` parameter is present. Because the extension now
  navigates to the app URL directly, requests legitimately arrive unsigned, so
  the route cannot require a signature without breaking checkout. Anyone who
  knows a shop domain and an order ID can therefore trigger payment creation for
  that order.
- **Impact:** No data disclosure — the response is a redirect to a Payram
  checkout for that order, and the amount is now authoritative (MF-001). The
  residual harm is resource abuse and nuisance: payram-core's
  `CancelPreviousOpenPaymentRequestsByMemberId` cancels that order's previously
  open payment request, so a third party can invalidate a checkout link a buyer
  is mid-way through paying. Order IDs are sequential and therefore guessable.
- **Mitigation:** partial (2026-09-03). The durable payment page `/pay/{token}`
  is now gated by an HMAC-signed order token, so a payment link cannot be edited
  to point at another order and is safe to bookmark or leave in browser history.
  **This does not close the flow.** Tokens are still minted by
  `/api/payram/redirect-to-payment`, which accepts a guessable `shopifyOrderId`,
  so an attacker who guesses an order can still obtain a valid token for it.
  Blast radius is reduced — the page exposes amounts only, no customer data — but
  the entry point remains unauthenticated.
- **To actually close it:** require a credential only the buyer holds. Either
  route the entry through the App Proxy so a Shopify signature is always present
  and can be mandatory, or bind token issuance to the order's own Shopify
  `order status URL` token.
- **Discovered:** while fixing MF-001/MF-002.

---

## MF-004 — Unsigned Payram webhook

- **Severity:** medium
- **Status:** superseded by **MF-013** (2026-10-22) for the signature, and by
  **MF-012** for what an unauthenticated webhook can do. Original entry kept below.
  (Was: **pending**, pre-existing; documented as a TODO in
  `app/routes/api.payram.webhook.tsx`.)
- **Attack:** `POST /api/payram/webhook` performs no signature verification. An
  attacker who learns or guesses a `referenceId` can post a `paid` status and
  have the Shopify order tagged `payram_paid` without any payment settling.
- **Impact:** A merchant relying on the tag could fulfil an unpaid order.
- **Mitigation:** partial — `referenceId` is a server-generated UUID and is not
  exposed to buyers, so it is unguessable in practice. Proper HMAC verification
  is blocked on Payram publishing a webhook signing mechanism. The connector
  does not mark orders paid in Shopify's financial sense, only tags them.

---

## MF-005 — Exchange-rate manipulation

- **Severity:** medium
- **Status:** accepted risk (v1)
- **Attack:** The USD amount depends on a third-party rate from
  `open.er-api.com`. An attacker able to control that response (provider
  compromise, DNS/TLS interception) could set a rate that under-charges buyers.
- **Mitigation:** partial. The call is HTTPS-only; obviously invalid rates
  (absent, non-numeric, ≤ 0) are rejected and fail closed rather than defaulting;
  the rate and its source are persisted per payment so a bad rate is auditable
  after the fact. A plausible-but-wrong rate would still be accepted.
- **Residual risk accepted** to match the WooCommerce connector's behaviour, as
  agreed for this change. A sanity band (reject rates deviating more than N%
  from the last cached value) or a second independent source would close it.

---

## MF-006 — SSRF via merchant-configured Payram base URL

- **Severity:** medium
- **Status:** mitigated (pre-existing)
- **Attack:** Merchants supply their own self-hosted Payram URL, which the server
  then fetches — a classic SSRF vector into the app host's network.
- **Mitigation:** `validatePayramBaseUrl` in `app/utils/payram.server.ts`
  enforces HTTPS and blocks loopback, link-local and RFC-1918 ranges.
  `ALLOW_INSECURE_PAYRAM_URL=true` bypasses this and must never be set in
  production.

---

## MF-007 — Unauthenticated payment status endpoint

- **Severity:** low
- **Status:** **pending**
- **Attack:** `GET /api/payram/status` performs no authentication. Anyone who
  knows a shop domain and an order ID — both guessable, as Shopify order IDs are
  sequential — can read that order's Payram status, order name, sync timestamps
  and `syncError` text.
- **Impact:** Information disclosure about a merchant's order flow. No customer
  PII and no checkout URL are returned (the checkout link is deliberately
  withheld), so the practical harm is low.
- **Mitigation:** none yet. Noted here because the currency work deliberately did
  **not** add the new money fields (`orderAmount`, `amountInUsd`, `fxRate`) to
  this response: widening an unauthenticated surface with per-order financial
  detail would turn a low-severity leak into a meaningful one. The conversion
  audit trail lives on `PaymentMapping` and is reachable through authenticated
  paths only. A follow-up should require app-session or HMAC auth here, after
  which the money fields can safely be exposed.
- **Discovered:** while fixing MF-001/MF-002.

---

## MF-008 — Gift card minting via forged webhook

- **Severity:** high
- **Status:** mitigated (2026-09-03)
- **Attack:** Automatic overpayment refunds mean an inbound webhook can now cause
  money to be created. `POST /api/payram/webhook` has no signature (MF-004), and
  the payload carries `filled_amount_in_usd`. An attacker who learned a
  `reference_id` — or who guessed a `customer_id`, which is the derivable string
  `shopify:{shop}:order:{orderId}` — could post `OVER_FILLED` with a large filled
  amount and have the connector issue a Shopify gift card for the difference.
- **Affected surfaces:** `api.payram.webhook`, `settlement.server.ts`,
  `shopify-admin.server.ts` (`createGiftCard`).
- **Mitigation:** the webhook body is never trusted for money. Before settling,
  the connector re-reads the payment from Payram directly
  (`fetchPayramPayment` → `GET /api/v1/payment/reference/{id}`) and uses those
  figures. A gift card is issued only when `verified` is true. If Payram cannot
  be asked, the webhook answers 503 and records nothing (no payment row, tag or
  gift card), so payram-core resends it; the payment mapping carries a
  `syncError` until a delivery is confirmed (MF-012, 2026-10-22; before that the
  payment was recorded and tagged unconfirmed). This mirrors the WooCommerce
  connector's `fetch_payment_status()` defence-in-depth.
  Defence in depth: the feature is **off by default**, requires the merchant to
  opt in, enforces a configurable minimum, and refuses to issue a second card for
  an order that already has one.
- **Follow-up (2026-09-03):** re-verification alone was NOT sufficient. It proved
  the reference existed on the shop's Payram, but not that the payment belonged
  to the order the webhook had been matched to — so a reference legitimately
  belonging to order A could be posted with order B's `customer_id` and have its
  funds, and any resulting gift card, credited to B. `fetchPayramPayment` now
  returns Payram's own `customerId` and the webhook refuses to settle unless it
  matches `shopify:{shop}:order:{orderId}` (or a top-up suffix of it).
- **Residual risk:** an attacker who can forge a webhook can still cause an order
  to be *tagged* (not gift-carded) with an incorrect state. MF-004 remains the
  root fix.
  **Superseded by MF-012 (2026-10-22):** that residual risk was larger than
  stated — an unverified amount was recorded and later summed with verified
  ones, so it COULD mint value. Fixed there.
- **Follow-up (2026-10-26, audit F3):** a second card could also come from the
  merchant's own instructions. Whenever no card could be issued (gift cards
  off, or the card could not be created) the merchant was told "Refund
  manually", but the slot was left open (`giftCardId` NULL), so the next
  delivery or Re-check payment issued a card once the cause went away — and
  1.2.0 removed the cause for every order with a customer. A merchant who had
  refunded by hand refunded twice. `giftCardId = 'manual_refund'` now closes
  the slot whenever the merchant is told to refund by hand, and the migration
  `20261026120000_manual_refund_gift_card_slot` closed it for the orders
  earlier releases had told so (matched on the `syncError` words, the only
  record they kept). Residual: an order whose "Refund manually" text was later
  replaced by another `syncError` before the upgrade is not recognised and
  stays open.
- **Follow-up (2026-10-26, audit F4):** `giftCardCreate` timing out after
  Shopify made the card freed the slot, so the next delivery or Re-check
  minted a second card. An unclear failure (`GiftCardOutcomeUnknownError`) now
  keeps the slot reserved (`giftCardId = 'unconfirmed:<time>'`) and tells the
  merchant not to refund by hand. No card is created again until, at least ten
  minutes later, Shopify's gift card list has been read in full and holds no
  card whose note carries the order marker `[Payram order <id>]` (every card's
  note does); a card that is there is recorded instead. A failed or incomplete
  read keeps the slot reserved. Residual: a merchant who refunds by hand
  anyway, despite the message, and then presses Re-check on an order where
  Shopify made nothing is refunded twice; a card made more than ten minutes
  after the timeout is not expected but would not be seen.
- **Discovered-in:** overpayment/gift-card work, 2026-09-03.

---

## MF-009 — Payment link secret rotation

- **Severity:** low
- **Status:** mitigated by configuration (2026-09-03)
- **Attack:** Not an attack so much as an availability trap. `/pay/{token}` links
  are signed with `PAYMENT_LINK_SECRET`, falling back to `SHOPIFY_API_SECRET`. If
  a merchant rotates their Shopify API secret while relying on the fallback,
  every outstanding payment link stops verifying at once — including links held
  by buyers who have already part-paid.
- **Mitigation:** `PAYMENT_LINK_SECRET` is documented in `.env.example` as the
  value to set explicitly in production, precisely so it can be rotated
  independently of Shopify credentials. Tokens carry a version prefix, so a
  future rotation can accept both old and new secrets during a cutover.
- **Discovered-in:** durable payment page work, 2026-09-03.

---

## MF-010 — Unauthenticated overwrite of the buyer's receipt address

- **Severity:** medium
- **Status:** mitigated (2026-09-03)
- **Attack:** `/api/payram/redirect-to-payment` is unauthenticated (MF-003) and
  order IDs are sequential. It upserted `buyerEmail` from a query parameter, and
  `createCheckout` passes that address to Payram as `customerEmail`. So
  `?shopifyOrderId=1001&shop=victim.myshopify.com&email=attacker@evil.com`
  redirected a real buyer's payment receipt to an attacker. The same upsert also
  fabricated `PaymentMapping` rows for arbitrary order IDs, which then appeared
  in the merchant's dashboard as real payment activity.
- **Mitigation:** the route now uses `updateMany` scoped to
  `{ shop, shopifyOrderId, buyerEmail: null }` — it can never create a row, and
  can never overwrite an address already recorded. A first payment carries the
  email for one hop in the redirect URL instead; the payment page consumes it and
  strips it from the URL via `history.replaceState`, so a bookmarked link never
  contains an email address.
- **Discovered-in:** code review of the payment page work, 2026-09-03.

---

## MF-011 — Settlement from an unrecognised payment status

- **Severity:** critical
- **Status:** mitigated (2026-09-03)
- **Attack:** `normalizePayramState` maps any unknown value — including a webhook
  body with **no** `status` field at all — to `UNDEFINED`, and the webhook only
  short-circuited `OPEN` and `CANCELLED`. `UNDEFINED` fell through to
  `settleOrder`, which computed the balance from the attacker-supplied
  `filled_amount_in_usd` alone. Posting
  `{customer_id: "shopify:{shop}:order:1001", reference_id: "x",
  filled_amount_in_usd: "9999"}` with no status would tag the order
  `payram_paid`, set `shopifyFinancialStatus`, and add a "paid in full" note. The
  `verified` flag gated only gift cards, never the paid tag — so an unverifiable
  payment could still mark an order paid and get it shipped.
- **Mitigation:** the webhook refuses `UNDEFINED` outright and records a
  merchant-facing `syncError`; `settleOrder` carries the same refusal as defence
  in depth, since it is the function that tags orders and mints value. Amount
  parsing is now non-negative in both the webhook and `fetchPayramPayment` — a
  negative `filled_amount_in_usd` could previously subtract from an order's
  received total and flip a paid order back to underpaid.
- **Discovered-in:** code review of the payment page work, 2026-09-03.

---

## MF-012 — Forged webhook amounts counted toward an order (two-step)

- **Severity:** critical
- **Status:** mitigated (2026-10-22)
- **Attack:** When a webhook's `reference_id` was unknown, the connector found
  the order from `customer_id` — `shopify:{shop}:order:{id}`, printed in the
  buyer's own payment link. Payram, asked about the made-up reference, had no
  such payment, so the payment was "unverified" — and was then recorded anyway
  "from the webhook body only": its `filled_amount_in_usd` went into
  `PayramPayment`, the order was tagged `payram_paid` and noted "paid in full".
  `sumReceivedUsd` added every non-cancelled row, confirmed or not. So a buyer
  posts one forged webhook claiming $150 on a $100 order, then really pays $1:
  Payram's genuine webhook for the $1 is verified, the total reads $151, and the
  connector calls `orderMarkAsPaid` and issues a $51 gift card. The payment page
  told the buyer "nothing left to pay" after the forged message alone. During a
  Payram outage a forged webhook could also overwrite the amount of an existing
  real reference, or wipe it with a forged `CANCELLED`/`OPEN`.
- **Affected surfaces:** `api.payram.webhook`, `settlement.server.ts`
  (`settleOrder`, `sumReceivedUsd`), `payment-session.server.ts` (`quoteOrder`),
  Re-check payment in `app._index.tsx` (credited a reference without checking
  it belonged to the order), every `PayramPayment` row written before the fix.
- **Mitigation:** one rule — only figures Payram itself confirms (the reference
  exists AND its customerId is this order's) become money received, tag or note
  an order, mark it paid, or mint a gift card.
  - The webhook confirms every reference with Payram before it records a
    payment or touches the Shopify order, and records Payram's figures, never
    the body's. The only write before that is a diagnostic `syncError` on the
    payment mapping, for a message that is unrecognised, rejected or not yet
    confirmable; it is never a tag, note or amount. Payram says no → 200 and a
    merchant-facing `syncError`; Payram cannot be asked → 503 so payram-core
    resends (it retries any status ≥ 400: `pkg/utils/utils.go`
    `SendWebhookToMerchant`; schedule in `webhook_delivery_service_impl.go`).
  - `PayramPayment.verifiedAt` marks confirmed rows; `sumReceivedUsd` — shared
    by settlement and the payment page — counts confirmed rows only.
    `settleOrder` refuses `verified: false` outright.
  - Rows from before the fix are unconfirmed and do not count. They are
    confirmed lazily (≤ 5 per settlement or payment-page visit; every reference
    on Re-check payment); rows Payram rejects get `rejectedAt`, never count, are
    never retried automatically, and keep the claimed figures as the audit
    trail (plus a log line and the order's `syncError`).
  - The repeat-delivery shortcut only applies to a row already confirmed for
    the same order, and only when the confirmed total equals what settlement
    last acted on.
  - A confirmed reference moves to the order Payram says owns it.
- **Residual risk:** orders already exploited before the fix keep whatever
  Shopify state and gift card they got; the next settlement re-tags and notes
  them from confirmed figures, but a gift card cannot be clawed back
  automatically. A legacy row whose real amount a forged `CANCELLED` had wiped
  is not looked up automatically (it counts nothing either way); Re-check
  payment restores it.
- **Discovered-in:** security audit, 2026-10-22 (reproduced end to end).

---

## MF-013 — Webhook signature (supersedes MF-004's mitigation)

- **Severity:** medium
- **Status:** partially mitigated (2026-10-22)
- **Attack:** as MF-004 — anyone can post to `/api/payram/webhook`.
- **Finding:** payram-core 3.9.0+ signs every webhook it sends (payment, payout
  and ping) with `X-Payram-Signature: sha256=<hex HMAC-SHA256 of the raw body,
  keyed with the project API key>` (`pkg/utils/utils.go` → `signWebhook`). It
  signs with the project's newest active admin key
  (`api_key_repo_impl.go` → `GetByExternalPlatformId`), not necessarily the key
  the merchant pasted into this app.
- **Mitigation:** per-shop enforcement. The first webhook that verifies with
  the saved key records `MerchantConfig.signedWebhooksSince`; from then on an
  unsigned or wrongly signed webhook is refused with 401 before anything is
  read from Payram or written. If the saved key itself cannot be read (for
  example it fails to decrypt), no signature can be checked: the webhook gets
  503 instead, because the Payram lookup needs the same key, and nothing is
  recorded. Saving a different Payram URL or API key clears
  it. Until a shop has proven its Payram signs, webhooks are accepted
  unauthenticated — safe because of MF-012, which never believes the body.
- **Residual risk:** on Payram before 3.9.0, or where the saved key is not the
  signing key, forged webhooks still reach the confirmation step: they cost one
  Payram lookup each and can replace the order's `syncError` with a "could not
  be confirmed" note (nuisance, no money). Once a shop is enforcing, a new admin
  API key created in Payram makes its webhooks fail 401 until that key is saved
  in the app; Payram keeps resending meanwhile and Re-check payment still works.
- **Discovered-in:** security audit, 2026-10-22.
