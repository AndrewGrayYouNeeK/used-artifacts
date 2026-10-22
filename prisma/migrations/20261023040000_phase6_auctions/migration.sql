-- CreateEnum
CREATE TYPE "RetractionReason" AS ENUM ('TYPO', 'DESCRIPTION_CHANGED', 'SELLER_UNREACHABLE');

-- CreateEnum
CREATE TYPE "RetractionStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuctionStatus" ADD VALUE 'UNSOLD';
ALTER TYPE "AuctionStatus" ADD VALUE 'AWAITING_SELLER';

-- DropIndex
DROP INDEX "Auction_listingId_key";

-- AlterTable
ALTER TABLE "Auction" ADD COLUMN     "bidCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "currentPriceCents" INTEGER,
ADD COLUMN     "durationDays" INTEGER NOT NULL,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "relistOfId" TEXT,
ADD COLUMN     "reserveMet" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sellerDecisionDueAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "winnerUserId" TEXT,
ALTER COLUMN "startsAt" DROP NOT NULL,
ALTER COLUMN "endsAt" DROP NOT NULL,
ALTER COLUMN "originalEndsAt" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Bid" ADD COLUMN     "priceBeforeCents" INTEGER NOT NULL,
ALTER COLUMN "maxProxyCents" SET NOT NULL;

-- AlterTable
ALTER TABLE "BidRetraction" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decisionNotes" TEXT,
ADD COLUMN     "kind" "RetractionReason" NOT NULL,
ADD COLUMN     "status" "RetractionStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "NonPayingBidderStrike" ADD COLUMN     "orderId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Auction_orderId_key" ON "Auction"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Auction_relistOfId_key" ON "Auction"("relistOfId");

-- CreateIndex
CREATE INDEX "Auction_listingId_idx" ON "Auction"("listingId");

-- CreateIndex
CREATE INDEX "Auction_status_endsAt_idx" ON "Auction"("status", "endsAt");

-- CreateIndex
CREATE INDEX "BidRetraction_status_createdAt_idx" ON "BidRetraction"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NonPayingBidderStrike_orderId_key" ON "NonPayingBidderStrike"("orderId");

-- CreateIndex
CREATE INDEX "NonPayingBidderStrike_userId_createdAt_idx" ON "NonPayingBidderStrike"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_winnerUserId_fkey" FOREIGN KEY ("winnerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auction" ADD CONSTRAINT "Auction_relistOfId_fkey" FOREIGN KEY ("relistOfId") REFERENCES "Auction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────────── Guards (hand-written) ─────────────

-- A listing has at most one auction that isn't relisted or cancelled.
CREATE UNIQUE INDEX "auction_one_current_per_listing" ON "Auction"("listingId")
  WHERE "status" NOT IN ('RELISTED', 'CANCELLED');

ALTER TABLE "Auction" ADD CONSTRAINT "auction_terms_valid" CHECK (
  "startingBidCents" > 0
  AND ("reserveCents" IS NULL OR "reserveCents" >= "startingBidCents")
  AND "isNoReserve" = ("reserveCents" IS NULL)
  AND "durationDays" BETWEEN 1 AND 14
  AND "softCloseMinutes" BETWEEN 0 AND 60
  AND "paymentWindowHours" > 0
  AND "bidCount" >= 0
  AND ("currentPriceCents" IS NULL OR "currentPriceCents" >= "startingBidCents")
);
ALTER TABLE "Bid" ADD CONSTRAINT "bid_amounts_valid"
  CHECK ("amountCents" > 0 AND "maxProxyCents" > 0 AND "priceBeforeCents" >= 0);

-- Auctions move only along the lifecycle in src/domains/auctions/auctions.ts.
CREATE FUNCTION auction_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    IF OLD."status"::text NOT IN ('SCHEDULED', 'LIVE', 'ENDED', 'AWAITING_SELLER')
       AND ROW(NEW."currentPriceCents", NEW."winnerUserId", NEW."orderId", NEW."closedAt")
           IS DISTINCT FROM ROW(OLD."currentPriceCents", OLD."winnerUserId", OLD."orderId", OLD."closedAt") THEN
      RAISE EXCEPTION 'A finished auction is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD."status"::text, NEW."status"::text) IN (
    ('SCHEDULED', 'LIVE'), ('SCHEDULED', 'CANCELLED'),
    ('LIVE', 'ENDED'), ('LIVE', 'UNSOLD'), ('LIVE', 'CANCELLED'),
    ('ENDED', 'SETTLED'), ('ENDED', 'AWAITING_SELLER'),
    ('AWAITING_SELLER', 'ENDED'), ('AWAITING_SELLER', 'RELISTED'), ('AWAITING_SELLER', 'CANCELLED')
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Illegal auction status change % -> %', OLD."status", NEW."status";
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER auction_status_guard BEFORE UPDATE ON "Auction"
  FOR EACH ROW EXECUTE FUNCTION auction_status_guard();
CREATE FUNCTION auction_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Auctions are never deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER auction_no_delete BEFORE DELETE ON "Auction"
  FOR EACH ROW EXECUTE FUNCTION auction_no_delete();

-- Bids are a permanent record: amounts never change, retracted and voided bids stay that way.
CREATE FUNCTION bid_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bids are never deleted';
  END IF;
  IF ROW(NEW."auctionId", NEW."bidderUserId", NEW."amountCents", NEW."maxProxyCents", NEW."priceBeforeCents", NEW."placedAt")
     IS DISTINCT FROM ROW(OLD."auctionId", OLD."bidderUserId", OLD."amountCents", OLD."maxProxyCents", OLD."priceBeforeCents", OLD."placedAt") THEN
    RAISE EXCEPTION 'Bids are immutable';
  END IF;
  IF OLD."status" IN ('RETRACTED', 'VOIDED_SHILL') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'A % bid is final', OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bid_guard BEFORE UPDATE OR DELETE ON "Bid"
  FOR EACH ROW EXECUTE FUNCTION bid_guard();

CREATE FUNCTION bid_retraction_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bid retractions are never deleted';
  END IF;
  IF ROW(NEW."bidId", NEW."kind", NEW."reason", NEW."createdAt") IS DISTINCT FROM ROW(OLD."bidId", OLD."kind", OLD."reason", OLD."createdAt") THEN
    RAISE EXCEPTION 'Bid retraction requests are immutable';
  END IF;
  IF OLD."status" <> 'PENDING' AND ROW(NEW."status", NEW."approvedById", NEW."decisionNotes", NEW."decidedAt")
     IS DISTINCT FROM ROW(OLD."status", OLD."approvedById", OLD."decisionNotes", OLD."decidedAt") THEN
    RAISE EXCEPTION 'A decided retraction is final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bid_retraction_guard BEFORE UPDATE OR DELETE ON "BidRetraction"
  FOR EACH ROW EXECUTE FUNCTION bid_retraction_guard();

CREATE FUNCTION nonpay_strike_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Non-paying bidder strikes are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER nonpay_strike_guard BEFORE UPDATE OR DELETE ON "NonPayingBidderStrike"
  FOR EACH ROW EXECUTE FUNCTION nonpay_strike_guard();
