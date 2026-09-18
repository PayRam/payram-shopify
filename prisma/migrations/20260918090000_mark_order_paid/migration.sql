-- Record when Shopify's own financial status was set to PAID.
--
-- The connector previously only tagged orders `payram_paid`, leaving Shopify
-- showing "Payment pending" forever. Tags are invisible to payouts, order
-- filters, reports and fulfilment apps, so merchants had to click "Mark as paid"
-- by hand on every crypto order.
ALTER TABLE "PaymentMapping" ADD COLUMN "shopifyMarkedPaidAt" DATETIME;
