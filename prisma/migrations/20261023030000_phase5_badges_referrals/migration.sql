-- AlterEnum
ALTER TYPE "FraudDetector" ADD VALUE 'REFERRAL_ABUSE';

-- AlterEnum
ALTER TYPE "ReferralEarningStatus" ADD VALUE 'FROZEN';

-- AlterTable
ALTER TABLE "ReferralEarning" ADD COLUMN     "clawbackReason" TEXT,
ADD COLUMN     "frozenReason" TEXT,
ADD COLUMN     "payableAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "payoutId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "referralCode" TEXT;

-- CreateTable
CREATE TABLE "ReferralPayout" (
    "id" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "destinationAccountId" TEXT NOT NULL,
    "stripeTransferId" TEXT,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralPayout_idempotencyKey_key" ON "ReferralPayout"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralPayout_stripeTransferId_key" ON "ReferralPayout"("stripeTransferId");

-- CreateIndex
CREATE INDEX "ReferralPayout_status_idx" ON "ReferralPayout"("status");

-- CreateIndex
CREATE INDEX "ReferralEarning_status_payableAt_idx" ON "ReferralEarning"("status", "payableAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- AddForeignKey
ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "ReferralPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralPayout" ADD CONSTRAINT "ReferralPayout_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Referrals are permanent: who recruited whom never changes (earnings depend on it).
ALTER TABLE "Referral" ADD CONSTRAINT "referral_not_self" CHECK ("referrerUserId" <> "refereeUserId");

CREATE FUNCTION referral_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Referrals cannot be deleted';
  END IF;
  IF NEW."referrerUserId" IS DISTINCT FROM OLD."referrerUserId"
     OR NEW."refereeUserId" IS DISTINCT FROM OLD."refereeUserId"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."firstSaleOrderId" IS NOT NULL AND NEW."firstSaleOrderId" IS DISTINCT FROM OLD."firstSaleOrderId") THEN
    RAISE EXCEPTION 'Referrals are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER referral_guard BEFORE UPDATE OR DELETE ON "Referral"
  FOR EACH ROW EXECUTE FUNCTION referral_guard();

-- Earnings: the amounts are fixed when accrued, and status only moves along these edges:
--   PENDING -> PAYABLE | FROZEN | CLAWED_BACK
--   FROZEN  -> PENDING | PAYABLE | CLAWED_BACK
--   PAYABLE -> PAID | FROZEN | CLAWED_BACK
--   PAID and CLAWED_BACK are final.
ALTER TABLE "ReferralEarning" ADD CONSTRAINT "referral_earning_amounts" CHECK ("amountCents" >= 0 AND "basisCents" >= 0 AND "rateBps" >= 0);

CREATE FUNCTION referral_earning_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Referral earnings cannot be deleted';
  END IF;
  IF NEW."referralId" IS DISTINCT FROM OLD."referralId"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."rateBps" IS DISTINCT FROM OLD."rateBps"
     OR NEW."basis" IS DISTINCT FROM OLD."basis"
     OR NEW."basisCents" IS DISTINCT FROM OLD."basisCents"
     OR NEW."platformFeeCents" IS DISTINCT FROM OLD."platformFeeCents"
     OR NEW."cappedAtFee" IS DISTINCT FROM OLD."cappedAtFee"
     OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Referral earning amounts are immutable';
  END IF;
  IF OLD."status"::text IN ('PAID', 'CLAWED_BACK') AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."payoutId" IS DISTINCT FROM OLD."payoutId") THEN
    RAISE EXCEPTION 'Referral earning is final (%)', OLD."status";
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status"::text = 'PENDING' AND NEW."status"::text IN ('PAYABLE', 'FROZEN', 'CLAWED_BACK'))
    OR (OLD."status"::text = 'FROZEN' AND NEW."status"::text IN ('PENDING', 'PAYABLE', 'CLAWED_BACK'))
    OR (OLD."status"::text = 'PAYABLE' AND NEW."status"::text IN ('PAID', 'FROZEN', 'CLAWED_BACK'))
  ) THEN
    RAISE EXCEPTION 'Referral earning cannot go from % to %', OLD."status", NEW."status";
  END IF;
  IF NEW."status"::text = 'PAID' AND NEW."payoutId" IS NULL THEN
    RAISE EXCEPTION 'A paid referral earning needs its payout';
  END IF;
  IF NEW."status"::text = 'FROZEN' AND NEW."frozenReason" IS NULL THEN
    RAISE EXCEPTION 'Freezing a referral earning needs a reason';
  END IF;
  IF NEW."status"::text = 'CLAWED_BACK' AND (NEW."clawbackReason" IS NULL OR NEW."payoutId" IS NOT NULL) THEN
    RAISE EXCEPTION 'A clawback needs a reason and must not be attached to a payout';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER referral_earning_guard BEFORE UPDATE OR DELETE ON "ReferralEarning"
  FOR EACH ROW EXECUTE FUNCTION referral_earning_guard();

ALTER TABLE "ReferralPayout" ADD CONSTRAINT "referral_payout_positive" CHECK ("amountCents" > 0);

-- Badges every environment needs (the dev seed upserts the same codes).
INSERT INTO "Badge" ("id", "code", "name", "kind", "description", "criteria") VALUES
  ('badge_beta_founder', 'BETA_FOUNDER', 'Beta Founder', 'COSMETIC', 'One of the first 100 sellers. Cosmetic only: no effect on fees or ranking.', '{"firstNSellers": 100}'),
  ('badge_first_sale', 'FIRST_SALE', 'First Sale', 'VOLUME', 'Completed a first released sale.', '{"releasedSalesCount": 1}'),
  ('badge_established_seller', 'ESTABLISHED_SELLER', 'Established Seller', 'VOLUME', '10 released sales.', '{"releasedSalesCount": 10}'),
  ('badge_trusted_dealer', 'TRUSTED_DEALER', 'Trusted Dealer', 'VOLUME', '50 released sales.', '{"releasedSalesCount": 50}'),
  ('badge_collector', 'COLLECTOR', 'Collector', 'VOLUME', '10 completed purchases.', '{"releasedPurchasesCount": 10}')
ON CONFLICT ("code") DO NOTHING;

-- Beta Founder is capped at its firstNSellers count, ever (revoked awards still used a slot).
CREATE FUNCTION beta_founder_cap() RETURNS trigger AS $$
DECLARE
  cap integer;
  awarded integer;
BEGIN
  SELECT ("criteria"->>'firstNSellers')::integer INTO cap FROM "Badge" WHERE "id" = NEW."badgeId" AND "code" = 'BETA_FOUNDER';
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('beta_founder_cap'));
  SELECT count(*) INTO awarded FROM "UserBadge" WHERE "badgeId" = NEW."badgeId";
  IF awarded >= cap THEN
    RAISE EXCEPTION 'All % Beta Founder badges have been awarded', cap;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER beta_founder_cap BEFORE INSERT ON "UserBadge"
  FOR EACH ROW EXECUTE FUNCTION beta_founder_cap();

-- Badge awards are never deleted (revocation sets revokedAt, so history stays).
CREATE FUNCTION user_badge_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Badge awards cannot be deleted; revoke them instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_badge_no_delete BEFORE DELETE ON "UserBadge"
  FOR EACH ROW EXECUTE FUNCTION user_badge_no_delete();
