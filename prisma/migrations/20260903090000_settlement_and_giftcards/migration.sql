-- Under/overpayment settlement.
--
-- Payram reports FILLED / PARTIALLY_FILLED / OVER_FILLED. The connector
-- previously collapsed this to paid/unpaid, so a short payment looked identical
-- to a complete one. These columns record what actually arrived, the signed
-- balance, and any gift card issued for an overpayment.
--
-- Money is TEXT for the same reason as the existing columns: SQLite's NUMERIC
-- affinity can demote DECIMAL to floating point.
--
-- Gift card codes are bearer value. Only the Shopify GID and the last few
-- characters are stored, never the redeemable code.

-- AlterTable
ALTER TABLE "MerchantConfig" ADD COLUMN "autoGiftCardOnOverpayment" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MerchantConfig" ADD COLUMN "giftCardMinimumUsd" TEXT NOT NULL DEFAULT '1.00';

-- AlterTable
ALTER TABLE "PaymentMapping" ADD COLUMN "paymentState" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "filledAmountInUsd" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "balanceUsd" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "giftCardId" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "giftCardLastChars" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "giftCardAmount" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "giftCardCurrency" TEXT;

-- CreateTable
-- One row per Payram payment reference. Top-ups arrive under a NEW reference
-- (payram-core creates a fresh payment request rather than accumulating), so an
-- order can have several. Keying on the reference also makes webhook retries
-- idempotent instead of double-counting received funds.
CREATE TABLE "PayramPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "payramReferenceId" TEXT NOT NULL,
    "state" TEXT,
    "filledAmountInUsd" TEXT,
    "txHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PayramPayment_payramReferenceId_key" ON "PayramPayment"("payramReferenceId");

-- CreateIndex
CREATE INDEX "PayramPayment_shop_shopifyOrderId_idx" ON "PayramPayment"("shop", "shopifyOrderId");

-- Merchant-tunable settlement tolerance.
-- A flat one-cent tolerance is wrong for crypto: network fees and price drift
-- between quote and send scale with the order, so a $1000 invoice can arrive
-- short by several dollars through no fault of the buyer. Effective tolerance is
-- max(invoice x percent, floor), both merchant-configurable.
ALTER TABLE "MerchantConfig" ADD COLUMN "settlementTolerancePercent" TEXT NOT NULL DEFAULT '1.0';
ALTER TABLE "MerchantConfig" ADD COLUMN "settlementToleranceMinUsd" TEXT NOT NULL DEFAULT '1.00';
