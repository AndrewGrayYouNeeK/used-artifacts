-- AlterTable
ALTER TABLE "AiAnalysis" ADD COLUMN     "blocksPublishing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "photoHashes" TEXT[],
ADD COLUMN     "requestedByUserId" TEXT,
ADD COLUMN     "sellerDecisions" JSONB;

-- CreateIndex
CREATE INDEX "AiAnalysis_requestedByUserId_createdAt_idx" ON "AiAnalysis"("requestedByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AiAnalysis_listingId_idx" ON "AiAnalysis"("listingId");

-- AddForeignKey
ALTER TABLE "AiAnalysis" ADD CONSTRAINT "AiAnalysis_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Analyzer results are evidence for compliance review: the output never changes after it is
-- recorded. Only the listing link, photo ids, and seller decisions may be filled in, once.
CREATE FUNCTION ai_analysis_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AiAnalysis rows are immutable';
  END IF;
  IF NEW."rawOutput" IS DISTINCT FROM OLD."rawOutput"
     OR NEW."normalizedOutput" IS DISTINCT FROM OLD."normalizedOutput"
     OR NEW."uncertainty" IS DISTINCT FROM OLD."uncertainty"
     OR NEW."flags" IS DISTINCT FROM OLD."flags"
     OR NEW."guardrailActions" IS DISTINCT FROM OLD."guardrailActions"
     OR NEW."blocksPublishing" IS DISTINCT FROM OLD."blocksPublishing"
     OR NEW."error" IS DISTINCT FROM OLD."error"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."model" IS DISTINCT FROM OLD."model"
     OR NEW."promptVersion" IS DISTINCT FROM OLD."promptVersion"
     OR NEW."photoHashes" IS DISTINCT FROM OLD."photoHashes"
     OR NEW."categoryId" IS DISTINCT FROM OLD."categoryId"
     OR NEW."requestedByUserId" IS DISTINCT FROM OLD."requestedByUserId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'AiAnalysis output is immutable';
  END IF;
  IF OLD."listingId" IS NOT NULL AND NEW."listingId" IS DISTINCT FROM OLD."listingId" THEN
    RAISE EXCEPTION 'AiAnalysis is already attached to a listing';
  END IF;
  IF OLD."sellerDecisions" IS NOT NULL AND NEW."sellerDecisions" IS DISTINCT FROM OLD."sellerDecisions" THEN
    RAISE EXCEPTION 'AiAnalysis seller decisions are already recorded';
  END IF;
  IF cardinality(OLD."photoIds") > 0 AND NEW."photoIds" IS DISTINCT FROM OLD."photoIds" THEN
    RAISE EXCEPTION 'AiAnalysis photo ids are already recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_analysis_guard BEFORE UPDATE OR DELETE ON "AiAnalysis"
  FOR EACH ROW EXECUTE FUNCTION ai_analysis_guard();
