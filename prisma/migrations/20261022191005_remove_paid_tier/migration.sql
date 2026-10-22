-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_tierId_fkey";

-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_userId_fkey";

-- DropTable
DROP TABLE "Membership";

-- DropTable
DROP TABLE "MembershipTier";

-- DropEnum
DROP TYPE "MembershipStatus";

