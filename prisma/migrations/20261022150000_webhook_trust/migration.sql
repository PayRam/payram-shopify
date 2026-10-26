-- Only amounts Payram itself confirms count toward an order.
--
-- Payram's payment webhook was trusted for its amounts whenever the connector
-- could not re-check them with Payram. A buyer could post one forged webhook
-- (a made-up reference plus their order's customer_id), then really pay $1: the
-- forged $150 and the real $1 were summed, the order was marked paid and the
-- "overpayment" refunded as a gift card. Every PayramPayment row now records
-- whether Payram confirmed it, and only confirmed rows are money received.
--
-- Additive only. Rows already in the table get NULL here, i.e. unconfirmed:
-- they may hold forged amounts, so they stop counting until Payram confirms
-- them. The connector confirms them lazily, a few at a time, when the order is
-- next settled, when the buyer opens the payment page, and on Re-check payment.
-- Rows Payram rejects get rejectedAt and never count; their claimed state and
-- amount stay as the record of what was claimed.
ALTER TABLE "PayramPayment" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "PayramPayment" ADD COLUMN "rejectedAt" DATETIME;

-- payram-core 3.9.0+ signs every webhook (X-Payram-Signature: sha256=HMAC of
-- the raw body, keyed with the project API key). The first correctly signed
-- webhook a shop receives is recorded here; from then on unsigned or wrongly
-- signed webhooks are refused before anything is recorded. NULL keeps today's
-- behaviour for shops whose Payram does not sign yet.
ALTER TABLE "MerchantConfig" ADD COLUMN "signedWebhooksSince" DATETIME;
