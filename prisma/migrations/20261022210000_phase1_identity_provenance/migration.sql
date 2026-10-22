-- CreateEnum
CREATE TYPE "ProhibitedTermSeverity" AS ENUM ('BLOCK', 'REVIEW');

-- AlterEnum
ALTER TYPE "AccountLinkSignal" ADD VALUE 'SAME_PERSON_DETAILS';

-- AlterEnum
ALTER TYPE "ComplianceReviewReason" ADD VALUE 'BETA_FULL_REVIEW';

-- AlterEnum
ALTER TYPE "FraudDetector" ADD VALUE 'DUPLICATE_IDENTITY';

-- AlterEnum
BEGIN;
CREATE TYPE "IdentityVerificationStatus_new" AS ENUM ('PENDING', 'PROCESSING', 'REQUIRES_INPUT', 'VERIFIED', 'CANCELED', 'NEEDS_REVIEW', 'DUPLICATE_REJECTED', 'REJECTED');
ALTER TABLE "public"."IdentityVerification" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "IdentityVerification" ALTER COLUMN "status" TYPE "IdentityVerificationStatus_new" USING ("status"::text::"IdentityVerificationStatus_new");
ALTER TYPE "IdentityVerificationStatus" RENAME TO "IdentityVerificationStatus_old";
ALTER TYPE "IdentityVerificationStatus_new" RENAME TO "IdentityVerificationStatus";
DROP TYPE "public"."IdentityVerificationStatus_old";
ALTER TABLE "IdentityVerification" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterEnum
ALTER TYPE "ListingStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "ComplianceReview" ADD COLUMN     "flags" JSONB;

-- AlterTable
ALTER TABLE "IdentityVerification" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "conflictingUserId" TEXT,
ADD COLUMN     "consentNoticeVersion" INTEGER,
ADD COLUMN     "consentedAt" TIMESTAMP(3),
ADD COLUMN     "documentType" TEXT,
ADD COLUMN     "issuingCountry" TEXT,
ADD COLUMN     "lastErrorCode" TEXT,
ADD COLUMN     "personFingerprintHash" TEXT,
ADD COLUMN     "reviewNotes" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "estimatedAge" TEXT,
ADD COLUMN     "materials" TEXT,
ADD COLUMN     "regionOfOrigin" TEXT;

-- AlterTable
ALTER TABLE "ProhibitedTerm" ADD COLUMN     "severity" "ProhibitedTermSeverity" NOT NULL DEFAULT 'BLOCK';

-- AlterTable
ALTER TABLE "ProvenanceStatement" ADD COLUMN     "acquisitionDetails" TEXT NOT NULL,
ADD COLUMN     "attestationKeys" TEXT[],
ADD COLUMN     "iacaDisclosureAcknowledged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "landownerName" TEXT,
ADD COLUMN     "listingSnapshot" JSONB NOT NULL;

-- AlterTable
ALTER TABLE "ProvenanceStatementTemplate" ADD COLUMN     "attestations" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "isDraft" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdentityVerification_personFingerprintHash_idx" ON "IdentityVerification"("personFingerprintHash");

-- CreateIndex
CREATE INDEX "IdentityVerification_status_idx" ON "IdentityVerification"("status");


ALTER TABLE "ProvenanceStatementTemplate" ALTER COLUMN "attestations" DROP DEFAULT;

-- Templates: wording is versioned, never edited in place. A template only stops
-- being a draft when someone (counsel) is recorded as approving it.
ALTER TABLE "ProvenanceStatementTemplate" ADD CONSTRAINT "ProvenanceStatementTemplate_approval_check"
  CHECK ("isDraft" OR "approvedBy" IS NOT NULL);

CREATE FUNCTION provenance_template_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provenance statement templates cannot be deleted';
  END IF;
  IF NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."attestations" IS DISTINCT FROM OLD."attestations" THEN
    RAISE EXCEPTION 'Provenance template wording is immutable; create a new version instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provenance_template_guard
  BEFORE UPDATE OR DELETE ON "ProvenanceStatementTemplate"
  FOR EACH ROW EXECUTE FUNCTION provenance_template_guard();

-- Signed statements are evidence: no edits, no deletes.
ALTER TABLE "ProvenanceStatement" ADD CONSTRAINT "ProvenanceStatement_core_attestations_check"
  CHECK ("attestsNotFederalStateOrTribalLand"
     AND "attestsNotHumanRemainsFuneralSacredPatrimony"
     AND "attestsNotIndianMadeMisrepresented");
ALTER TABLE "ProvenanceStatement" ADD CONSTRAINT "ProvenanceStatement_landowner_check"
  CHECK ("acquisitionSource" <> 'PRIVATE_LAND_WITH_PERMISSION'
     OR ("landownerName" IS NOT NULL AND length(trim("landownerName")) > 0));

CREATE FUNCTION provenance_statement_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Signed provenance statements are immutable (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provenance_statement_immutable
  BEFORE UPDATE OR DELETE ON "ProvenanceStatement"
  FOR EACH ROW EXECUTE FUNCTION provenance_statement_immutable();

CREATE TRIGGER provenance_statement_no_truncate
  BEFORE TRUNCATE ON "ProvenanceStatement"
  FOR EACH STATEMENT EXECUTE FUNCTION provenance_statement_immutable();

-- A listing can only be LIVE with a signed provenance statement from an
-- ID-verified seller, whatever code path sets the status.
CREATE FUNCTION listing_live_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."status"::text = 'LIVE' AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status") THEN
    IF NOT EXISTS (
      SELECT 1 FROM "ProvenanceStatement" ps
      WHERE ps."listingId" = NEW."id" AND ps."sellerUserId" = NEW."sellerUserId"
    ) THEN
      RAISE EXCEPTION 'Listing % cannot go live without a signed provenance statement', NEW."id";
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "IdentityVerification" iv
      WHERE iv."userId" = NEW."sellerUserId" AND iv."status"::text = 'VERIFIED'
    ) THEN
      RAISE EXCEPTION 'Listing % cannot go live: seller identity is not verified', NEW."id";
    END IF;
    IF NEW."publishedAt" IS NULL THEN
      RAISE EXCEPTION 'Listing % cannot go live without publishedAt', NEW."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER listing_live_guard
  BEFORE INSERT OR UPDATE ON "Listing"
  FOR EACH ROW EXECUTE FUNCTION listing_live_guard();
