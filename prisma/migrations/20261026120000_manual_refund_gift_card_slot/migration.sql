-- An overpayment the merchant was told to refund by hand is never refunded
-- again automatically.
--
-- Releases up to 1.2.0 told the merchant "Refund manually" when gift cards were
-- off, when the gift card could not be created, and (before 1.2.0) when the
-- payment could not be verified with Payram — and recorded it only as those
-- words in PaymentMapping.syncError, leaving giftCardId NULL. On 1.1.0 every
-- order with a customer hit "could not be created" (an invalid recipient
-- field). 1.2.0 fixed that field and, finding giftCardId NULL, issued a gift
-- card on the next Re-check payment or delivery: a merchant who had refunded
-- by hand, as told, refunded the buyer twice.
--
-- giftCardId = 'manual_refund' now closes the slot (settlement.server.ts →
-- GIFT_CARD_MANUAL_REFUND). This moves those orders to it. The phrases are the
-- ones every release wrote, unchanged since gift cards shipped; SQLite's LIKE
-- ignores ASCII case. Only open slots are touched — never a pending claim or a
-- real card id — so running it again changes nothing.
UPDATE "PaymentMapping"
SET "giftCardId" = 'manual_refund'
WHERE "giftCardId" IS NULL
  AND "syncError" IS NOT NULL
  AND (
    "syncError" LIKE '%but the gift card could not be created:%Refund manually%'
    OR "syncError" LIKE '%Automatic gift cards are off, so this must be refunded manually%'
    OR "syncError" LIKE '%so no gift card was issued. Confirm the payment in Payram and refund manually%'
  );
