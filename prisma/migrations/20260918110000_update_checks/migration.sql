-- In-app update notices.
--
-- Self-hosting means nobody can push a fix to a merchant: the currency bug sat in
-- a published image for four months partly because there was no way to learn an
-- update existed. The connector now checks for releases and shows the notes and
-- the exact command, while leaving the decision to the merchant.
ALTER TABLE "MerchantConfig" ADD COLUMN "updateChecksEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "UpdateCheck" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "latestVersion" TEXT,
    "latestUrl" TEXT,
    "releaseNotes" TEXT,
    "publishedAt" DATETIME,
    "requiresInstaller" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" DATETIME NOT NULL,
    "lastError" TEXT
);
