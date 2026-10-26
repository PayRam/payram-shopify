-- @shopify/shopify-app-session-storage-prisma 8+ writes refreshToken and
-- refreshTokenExpires on every session save, so the columns must exist before
-- the upgraded app stores its first session. Additive and nullable: every
-- session saved by an earlier version keeps loading unchanged.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "refreshToken" TEXT;
ALTER TABLE "Session" ADD COLUMN "refreshTokenExpires" DATETIME;
