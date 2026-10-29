-- AlterTable
ALTER TABLE "GradingResult" ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "revokeReason" TEXT;

-- AlterTable
ALTER TABLE "GradingSubmission" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "GradingSubmission_status_createdAt_idx" ON "GradingSubmission"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "GradingResult" ADD CONSTRAINT "GradingResult_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One open authentication request per listing, and one published result per submission.
CREATE UNIQUE INDEX "GradingSubmission_one_open_per_listing" ON "GradingSubmission"("listingId")
  WHERE "listingId" IS NOT NULL AND "status" IN ('SUBMITTED', 'RECEIVED', 'IN_REVIEW');
CREATE UNIQUE INDEX "GradingResult_one_published_per_submission" ON "GradingResult"("submissionId")
  WHERE "status" = 'PUBLISHED';

-- Every result names exactly one grader: a partner (Stage 1) or an in-house grader (Stage 2).
ALTER TABLE "GradingResult" ADD CONSTRAINT "grading_result_one_grader"
  CHECK (("gradedByAuthenticatorId" IS NULL) <> ("gradedByUserId" IS NULL));

-- Grading results: drafts are editable; after that only the status moves forward. In-house
-- grades can't be published until a partner agrees (or adjusts), GRADED needs a rubric,
-- MUSEUM_GRADE isn't offered yet, and revoking needs a reason. Nothing is deleted.
CREATE FUNCTION grading_result_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Grading results cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status"::text <> 'DRAFT' AND (
       NEW."submissionId" IS DISTINCT FROM OLD."submissionId"
    OR NEW."rubricId" IS DISTINCT FROM OLD."rubricId"
    OR NEW."tierAwarded" IS DISTINCT FROM OLD."tierAwarded"
    OR NEW."criterionScores"::text IS DISTINCT FROM OLD."criterionScores"::text
    OR NEW."overallGrade" IS DISTINCT FROM OLD."overallGrade"
    OR NEW."notes" IS DISTINCT FROM OLD."notes"
    OR NEW."certificateNumber" IS DISTINCT FROM OLD."certificateNumber"
    OR NEW."photoKeys" IS DISTINCT FROM OLD."photoKeys"
    OR NEW."gradedByAuthenticatorId" IS DISTINCT FROM OLD."gradedByAuthenticatorId"
    OR NEW."gradedByUserId" IS DISTINCT FROM OLD."gradedByUserId"
    OR NEW."recordedById" IS DISTINCT FROM OLD."recordedById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR (OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt")
  ) THEN
    RAISE EXCEPTION 'Grading result is no longer editable (%)', OLD."status";
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status"::text = 'DRAFT' AND NEW."status"::text IN ('PENDING_VERIFICATION', 'PUBLISHED', 'REJECTED'))
    OR (OLD."status"::text = 'PENDING_VERIFICATION' AND NEW."status"::text IN ('VERIFIED', 'REJECTED'))
    OR (OLD."status"::text = 'VERIFIED' AND NEW."status"::text IN ('PUBLISHED', 'REJECTED'))
    OR (OLD."status"::text = 'PUBLISHED' AND NEW."status"::text = 'REVOKED')
  ) THEN
    RAISE EXCEPTION 'Grading result cannot go from % to %', OLD."status", NEW."status";
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status"::text NOT IN ('DRAFT', 'PUBLISHED', 'REJECTED') THEN
    RAISE EXCEPTION 'A grading result starts as a draft, published, or rejected';
  END IF;
  IF NEW."tierAwarded"::text = 'MUSEUM_GRADE' AND NEW."status"::text IN ('PUBLISHED', 'VERIFIED', 'PENDING_VERIFICATION') THEN
    RAISE EXCEPTION 'MUSEUM_GRADE is not offered yet';
  END IF;
  IF NEW."tierAwarded"::text = 'GRADED' AND NEW."rubricId" IS NULL AND NEW."status"::text <> 'DRAFT' THEN
    RAISE EXCEPTION 'A GRADED result needs a rubric';
  END IF;
  IF NEW."status"::text = 'PUBLISHED' THEN
    IF NEW."publishedAt" IS NULL THEN
      RAISE EXCEPTION 'A published result needs its publish time';
    END IF;
    IF NEW."gradedByUserId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "GradeVerification" v
      WHERE v."gradingResultId" = NEW.id AND v."decision"::text IN ('AGREE', 'ADJUST')
    ) THEN
      RAISE EXCEPTION 'An in-house grade needs a partner verification before it is published';
    END IF;
  END IF;
  IF NEW."status"::text = 'REVOKED' AND (NEW."revokedAt" IS NULL OR coalesce(length(trim(NEW."revokeReason")), 0) < 5) THEN
    RAISE EXCEPTION 'Revoking a result needs a time and a reason';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER grading_result_guard BEFORE INSERT OR UPDATE OR DELETE ON "GradingResult"
  FOR EACH ROW EXECUTE FUNCTION grading_result_guard();

-- Partner verifications are the accuracy record: append-only.
CREATE FUNCTION grade_verification_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Grade verifications are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER grade_verification_append_only BEFORE UPDATE OR DELETE ON "GradeVerification"
  FOR EACH ROW EXECUTE FUNCTION grade_verification_append_only();
