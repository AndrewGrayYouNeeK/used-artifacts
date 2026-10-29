-- AlterTable
ALTER TABLE "EnforcementAction" ADD COLUMN     "liftReason" TEXT,
ADD COLUMN     "liftedAt" TIMESTAMP(3),
ADD COLUMN     "liftedById" TEXT,
ADD COLUMN     "listingId" TEXT,
ADD COLUMN     "userBadgeId" TEXT;

-- AlterTable
ALTER TABLE "FraudSignal" ADD COLUMN     "reviewNotes" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- CreateIndex
CREATE INDEX "EnforcementAction_userId_createdAt_idx" ON "EnforcementAction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EnforcementAction_type_liftedAt_expiresAt_idx" ON "EnforcementAction"("type", "liftedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "FraudSignal" ADD CONSTRAINT "FraudSignal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "EnforcementAction_liftedById_fkey" FOREIGN KEY ("liftedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "EnforcementAction_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "EnforcementAction_userBadgeId_fkey" FOREIGN KEY ("userBadgeId") REFERENCES "UserBadge"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The owner can't be locked out through the dashboard (a compromised staff account must not be
-- able to suspend or ban the Proprietor).
CREATE FUNCTION user_owner_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'ACTIVE' AND (NEW."role" = 'OWNER' OR OLD."role" = 'OWNER') THEN
    RAISE EXCEPTION 'An OWNER account cannot be suspended or banned';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_owner_status_guard BEFORE UPDATE OF "status", "role" ON "User"
  FOR EACH ROW EXECUTE FUNCTION user_owner_status_guard();

-- Enforcement history is append-only: the only change allowed is lifting an action, once.
CREATE FUNCTION enforcement_action_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Enforcement actions cannot be deleted';
  END IF;
  IF OLD."liftedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Enforcement action is already lifted';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."fraudSignalId" IS DISTINCT FROM OLD."fraudSignalId"
     OR NEW."listingId" IS DISTINCT FROM OLD."listingId"
     OR NEW."userBadgeId" IS DISTINCT FROM OLD."userBadgeId"
     OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Enforcement actions are immutable; lift and issue a new one instead';
  END IF;
  IF NEW."liftedAt" IS NULL OR NEW."liftReason" IS NULL THEN
    RAISE EXCEPTION 'Lifting an enforcement action needs a time and a reason';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforcement_action_guard BEFORE UPDATE OR DELETE ON "EnforcementAction"
  FOR EACH ROW EXECUTE FUNCTION enforcement_action_guard();

ALTER TABLE "EnforcementAction" ADD CONSTRAINT "enforcement_reason_present" CHECK (length(trim("reason")) >= 5);
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "enforcement_listing_target" CHECK ("type" <> 'LISTING_REMOVED' OR "listingId" IS NOT NULL);
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "enforcement_badge_target" CHECK ("type" <> 'BADGE_REVOKED' OR "userBadgeId" IS NOT NULL);
ALTER TABLE "EnforcementAction" ADD CONSTRAINT "enforcement_expiry_only_suspension" CHECK ("expiresAt" IS NULL OR "type" = 'SUSPENSION');
