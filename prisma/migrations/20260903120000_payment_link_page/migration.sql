-- Durable per-order payment page.
--
-- /pay/{token} is the single surface for the first payment, live status, the
-- top-up retry and the paid confirmation. Reissuing a checkout link on every
-- visit would be wrong twice over: it wastes Payram payment requests, and
-- payram-core cancels a member's previously open request, which would kill a
-- link the buyer is part-way through paying. So we record what the live link was
-- issued for and reuse it while the outstanding amount is unchanged.
ALTER TABLE "PaymentMapping" ADD COLUMN "linkAmountUsd" TEXT;
ALTER TABLE "PaymentMapping" ADD COLUMN "linkCreatedAt" DATETIME;

-- Buyer email is stored rather than carried in the /pay URL: that link is meant
-- to be bookmarked and revisited, and a bookmarkable URL must not contain an
-- email address.
ALTER TABLE "PaymentMapping" ADD COLUMN "buyerEmail" TEXT;
