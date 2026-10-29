-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('OPEN', 'UPHELD', 'OVERTURNED');

-- AlterTable
ALTER TABLE "FraudSignal" ADD COLUMN     "dedupeKey" TEXT;

-- CreateTable
CREATE TABLE "FraudSignalOrder" (
    "signalId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,

    CONSTRAINT "FraudSignalOrder_pkey" PRIMARY KEY ("signalId","orderId")
);

-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "enforcementActionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'OPEN',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FraudSignalOrder_orderId_idx" ON "FraudSignalOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Appeal_enforcementActionId_key" ON "Appeal"("enforcementActionId");

-- CreateIndex
CREATE INDEX "Appeal_status_createdAt_idx" ON "Appeal"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FraudSignal_dedupeKey_key" ON "FraudSignal"("dedupeKey");

-- AddForeignKey
ALTER TABLE "FraudSignalOrder" ADD CONSTRAINT "FraudSignalOrder_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "FraudSignal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudSignalOrder" ADD CONSTRAINT "FraudSignalOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_enforcementActionId_fkey" FOREIGN KEY ("enforcementActionId") REFERENCES "EnforcementAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Signal-to-order links are evidence: append-only.
CREATE FUNCTION fraud_signal_order_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Fraud signal order links are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fraud_signal_order_append_only BEFORE UPDATE OR DELETE ON "FraudSignalOrder"
  FOR EACH ROW EXECUTE FUNCTION fraud_signal_order_append_only();

-- Appeals: only the sanctioned member appeals, a decision needs a decider and notes,
-- and a decided appeal is final.
CREATE FUNCTION appeal_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Appeals cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'OPEN' THEN
      RAISE EXCEPTION 'Appeals start open';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "EnforcementAction" WHERE id = NEW."enforcementActionId" AND "userId" = NEW."userId") THEN
      RAISE EXCEPTION 'Only the member the action was taken against can appeal it';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status"::text <> 'OPEN' THEN
    RAISE EXCEPTION 'Appeal is already decided (%)', OLD."status";
  END IF;
  IF NEW."enforcementActionId" IS DISTINCT FROM OLD."enforcementActionId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."message" IS DISTINCT FROM OLD."message"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Appeal contents are immutable';
  END IF;
  IF NEW."status"::text <> 'OPEN' AND (NEW."decidedById" IS NULL OR NEW."decidedAt" IS NULL OR coalesce(length(trim(NEW."decisionNotes")), 0) < 5) THEN
    RAISE EXCEPTION 'An appeal decision needs a decider, a time, and notes';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appeal_guard BEFORE INSERT OR UPDATE OR DELETE ON "Appeal"
  FOR EACH ROW EXECUTE FUNCTION appeal_guard();
