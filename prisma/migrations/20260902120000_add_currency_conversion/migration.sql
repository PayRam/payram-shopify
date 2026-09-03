-- Currency conversion support.
--
-- Payram's POST /api/v1/payment accepts `amountInUSD` only, and payram-core's
-- rate oracle converts crypto→USD exclusively -- it has no fiat rates. The
-- connector therefore converts the Shopify order total to USD itself and records
-- the conversion here so merchants can reconcile against the original order.
--
-- Money is TEXT, not DECIMAL: SQLite's NUMERIC affinity can silently demote
-- DECIMAL values to floating point, and PayRam never stores money as a float.

-- AlterTable
ALTER TABLE "PaymentMapping" ADD COLUMN "orderCurrency" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "orderAmount" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "fxRate" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "fxSource" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "amountInUsd" TEXT;

-- CreateTable
CREATE TABLE "FxRate" (
    "currency" TEXT NOT NULL PRIMARY KEY,
    "usdPerUnit" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL
);
