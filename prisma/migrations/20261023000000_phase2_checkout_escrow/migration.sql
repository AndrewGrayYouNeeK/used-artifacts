-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterEnum
ALTER TYPE "LedgerAccountKind" ADD VALUE 'TAX_PAYABLE';

-- AlterTable
ALTER TABLE "Dispute" ADD COLUMN     "isChargeback" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundCents" INTEGER,
ADD COLUMN     "resolutionNotes" TEXT,
ADD COLUMN     "resolvedById" TEXT;

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "shippingCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "releaseHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "releaseHoldReason" TEXT,
ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippingAddress" JSONB,
ADD COLUMN     "shippingAddressHash" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "checkoutSessionId" TEXT NOT NULL,
ADD COLUMN     "paymentFingerprintHash" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "stripePaymentIntentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "deliverySource" TEXT,
ADD COLUMN     "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "trackerId" TEXT;

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "destinationAccountId" TEXT NOT NULL,
ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "Order_shippingAddressHash_idx" ON "Order"("shippingAddressHash");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_checkoutSessionId_key" ON "Payment"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "Payment_paymentFingerprintHash_idx" ON "Payment"("paymentFingerprintHash");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Shipment_trackingNumber_idx" ON "Shipment"("trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_idempotencyKey_key" ON "Transfer"("idempotencyKey");


-- ───────────── Guards (hand-written) ─────────────

ALTER TABLE "Listing" ADD CONSTRAINT "listing_shipping_range"
  CHECK ("shippingCents" >= 0 AND "shippingCents" <= 100000);
ALTER TABLE "Order" ADD CONSTRAINT "order_extras_non_negative"
  CHECK ("shippingCents" >= 0 AND "taxCents" >= 0);
ALTER TABLE "Payment" ADD CONSTRAINT "payment_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "Transfer" ADD CONSTRAINT "transfer_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "refund_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "Dispute" ADD CONSTRAINT "dispute_refund_non_negative" CHECK ("refundCents" IS NULL OR "refundCents" >= 0);

-- A listing can have only one order that is pending, paid, or settled as a sale.
CREATE UNIQUE INDEX "order_one_active_per_listing" ON "Order"("listingId")
  WHERE "status" NOT IN ('EXPIRED', 'CANCELLED_REFUNDED', 'RESOLVED_REFUND');

-- Orders move only along the escrow state machine (src/domains/orders/state-machine.ts).
CREATE FUNCTION order_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  IF (OLD."status", NEW."status") IN (
    ('CREATED', 'PAID_HELD'), ('CREATED', 'EXPIRED'),
    ('PAID_HELD', 'SHIPPED'), ('PAID_HELD', 'DISPUTED'), ('PAID_HELD', 'CANCELLED_REFUNDED'),
    ('SHIPPED', 'DELIVERED'), ('SHIPPED', 'RELEASED'), ('SHIPPED', 'DISPUTED'),
    ('DELIVERED', 'RELEASED'), ('DELIVERED', 'AUTO_RELEASED'), ('DELIVERED', 'DISPUTED'),
    ('DISPUTED', 'RESOLVED_RELEASE'), ('DISPUTED', 'RESOLVED_REFUND'), ('DISPUTED', 'RESOLVED_PARTIAL')
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Illegal order status change % -> %', OLD."status", NEW."status";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_status_guard BEFORE UPDATE OF "status" ON "Order"
  FOR EACH ROW EXECUTE FUNCTION order_status_guard();

-- Released orders can't be put back on hold; auto-release needs carrier-confirmed delivery.
ALTER TABLE "Order" ADD CONSTRAINT "order_auto_release_needs_delivery"
  CHECK ("status" <> 'AUTO_RELEASED' OR "deliveredAt" IS NOT NULL);

-- Double-entry ledger: positive amounts, two different accounts, append-only.
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "ledger_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "ledger_distinct_accounts" CHECK ("debitAccountId" <> "creditAccountId");

CREATE FUNCTION ledger_entry_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ledger entries are immutable; post a reversing entry instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_immutable();
CREATE TRIGGER ledger_entry_no_truncate BEFORE TRUNCATE ON "LedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entry_immutable();
