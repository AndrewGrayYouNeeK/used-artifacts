-- CreateEnum
CREATE TYPE "KillSwitchKey" AS ENUM ('SIGNUPS', 'LISTINGS', 'CHECKOUT', 'BIDDING', 'PAYOUTS', 'AI_ANALYZER');

-- CreateEnum
CREATE TYPE "FeedbackCategory" AS ENUM ('BUG', 'IDEA', 'TRUST_SAFETY', 'OTHER');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'CLOSED');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "twoFactorVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TwoFactorCredential" (
    "userId" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "lastUsedStep" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwoFactorCredential_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "TwoFactorRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "ipHash" TEXT,
    "userAgent" TEXT,
    "deviceIdHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BetaInvite" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeHint" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "email" TEXT,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetaInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BetaInviteRedemption" (
    "id" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetaInviteRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KillSwitch" (
    "key" "KillSwitchKey" NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KillSwitch_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "message" TEXT NOT NULL,
    "pagePath" TEXT,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'OPEN',
    "staffNotes" TEXT,
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyReview" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "reviewedById" TEXT NOT NULL,
    "notes" TEXT,
    "openSignals" INTEGER NOT NULL,
    "pendingCompliance" INTEGER NOT NULL,
    "openFeedback" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyDigest" (
    "day" DATE NOT NULL,
    "recipients" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyDigest_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorRecoveryCode_codeHash_key" ON "TwoFactorRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "TwoFactorRecoveryCode_userId_idx" ON "TwoFactorRecoveryCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LoginChallenge_tokenHash_key" ON "LoginChallenge"("tokenHash");

-- CreateIndex
CREATE INDEX "LoginChallenge_userId_idx" ON "LoginChallenge"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BetaInvite_codeHash_key" ON "BetaInvite"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "BetaInviteRedemption_userId_key" ON "BetaInviteRedemption"("userId");

-- CreateIndex
CREATE INDEX "BetaInviteRedemption_inviteId_idx" ON "BetaInviteRedemption"("inviteId");

-- CreateIndex
CREATE INDEX "Feedback_status_createdAt_idx" ON "Feedback"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_userId_createdAt_idx" ON "Feedback"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyReview_day_key" ON "DailyReview"("day");

-- AddForeignKey
ALTER TABLE "TwoFactorCredential" ADD CONSTRAINT "TwoFactorCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorRecoveryCode" ADD CONSTRAINT "TwoFactorRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginChallenge" ADD CONSTRAINT "LoginChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BetaInvite" ADD CONSTRAINT "BetaInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BetaInviteRedemption" ADD CONSTRAINT "BetaInviteRedemption_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "BetaInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BetaInviteRedemption" ADD CONSTRAINT "BetaInviteRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KillSwitch" ADD CONSTRAINT "KillSwitch_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyReview" ADD CONSTRAINT "DailyReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Invites: the code, terms, and issuer never change; uses only go up one at a time; revocation is once.
ALTER TABLE "BetaInvite" ADD CONSTRAINT "beta_invite_uses_valid"
  CHECK ("maxUses" BETWEEN 1 AND 1000 AND "useCount" BETWEEN 0 AND "maxUses");

CREATE FUNCTION beta_invite_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Beta invites cannot be deleted; revoke them instead';
  END IF;
  IF NEW."codeHash" IS DISTINCT FROM OLD."codeHash"
     OR NEW."codeHint" IS DISTINCT FROM OLD."codeHint"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."email" IS DISTINCT FROM OLD."email"
     OR NEW."maxUses" IS DISTINCT FROM OLD."maxUses"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Beta invite terms are immutable';
  END IF;
  IF NEW."useCount" NOT IN (OLD."useCount", OLD."useCount" + 1) THEN
    RAISE EXCEPTION 'Beta invite uses only increase one at a time';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'Beta invite revocation is final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER beta_invite_guard BEFORE UPDATE OR DELETE ON "BetaInvite"
  FOR EACH ROW EXECUTE FUNCTION beta_invite_guard();

CREATE FUNCTION append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER beta_invite_redemption_append_only BEFORE UPDATE OR DELETE ON "BetaInviteRedemption"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER daily_review_append_only BEFORE UPDATE OR DELETE ON "DailyReview"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- Pausing a kill switch needs a reason (it is shown to staff and in the audit log).
ALTER TABLE "KillSwitch" ADD CONSTRAINT "kill_switch_pause_reason"
  CHECK (NOT "paused" OR ("reason" IS NOT NULL AND length(trim("reason")) > 0));

ALTER TABLE "Feedback" ADD CONSTRAINT "feedback_message_length"
  CHECK (length(trim("message")) BETWEEN 1 AND 5000);

-- A TOTP step, once accepted, can never be accepted again.
CREATE FUNCTION two_factor_step_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."lastUsedStep" IS NOT NULL AND (NEW."lastUsedStep" IS NULL OR NEW."lastUsedStep" < OLD."lastUsedStep")
     AND NEW."secretEncrypted" = OLD."secretEncrypted" THEN
    RAISE EXCEPTION 'TOTP steps only move forward';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER two_factor_step_guard BEFORE UPDATE ON "TwoFactorCredential"
  FOR EACH ROW EXECUTE FUNCTION two_factor_step_guard();
