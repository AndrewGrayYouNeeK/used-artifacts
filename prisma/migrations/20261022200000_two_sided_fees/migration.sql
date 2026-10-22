-- CreateEnum
CREATE TYPE "ReferralBasis" AS ENUM ('BUYER_PRICE', 'ASKING_PRICE');

-- AlterTable
ALTER TABLE "Listing" DROP COLUMN "featuredUntil",
DROP COLUMN "priceCents",
ADD COLUMN     "askingPriceCents" INTEGER;

-- AlterTable
ALTER TABLE "ListingPriceChange" DROP COLUMN "newPriceCents",
DROP COLUMN "oldPriceCents",
ADD COLUMN     "newAskingPriceCents" INTEGER NOT NULL,
ADD COLUMN     "oldAskingPriceCents" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "feeRateBps",
DROP COLUMN "subtotalCents",
ADD COLUMN     "askingPriceCents" INTEGER NOT NULL,
ADD COLUMN     "buyerFeeBps" INTEGER NOT NULL,
ADD COLUMN     "buyerFeeCents" INTEGER NOT NULL,
ADD COLUMN     "buyerPriceCents" INTEGER NOT NULL,
ADD COLUMN     "sellerFeeBps" INTEGER NOT NULL,
ADD COLUMN     "sellerFeeCents" INTEGER NOT NULL,
ADD COLUMN     "sellerPayoutCents" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "ReferralEarning" DROP COLUMN "kind",
ADD COLUMN     "basis" "ReferralBasis" NOT NULL;

-- DropEnum
DROP TYPE "ReferralEarningKind";


-- Two-sided fee invariants (owner decision B3): the buyer is charged exactly the
-- shown price, the seller receives asking minus their fee, and the platform keeps both fees.
ALTER TABLE "Order" ADD CONSTRAINT "Order_buyer_price_check"
  CHECK ("buyerPriceCents" = "askingPriceCents" + "buyerFeeCents");
ALTER TABLE "Order" ADD CONSTRAINT "Order_seller_payout_check"
  CHECK ("sellerPayoutCents" = "askingPriceCents" - "sellerFeeCents");
ALTER TABLE "Order" ADD CONSTRAINT "Order_platform_fee_check"
  CHECK ("platformFeeCents" = "buyerFeeCents" + "sellerFeeCents");
ALTER TABLE "Order" ADD CONSTRAINT "Order_amounts_nonnegative_check"
  CHECK ("askingPriceCents" >= 0 AND "buyerFeeCents" >= 0 AND "sellerFeeCents" >= 0 AND "sellerPayoutCents" >= 0);
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_asking_price_check"
  CHECK ("askingPriceCents" IS NULL OR "askingPriceCents" > 0);
ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_cap_check"
  CHECK ("amountCents" >= 0 AND (NOT "cappedAtFee" OR "amountCents" <= "platformFeeCents"));
