import { randomInt, randomUUID } from "node:crypto";
import type { Db } from "@/lib/db";
import { Prisma, type Order, type ReferralEarning } from "@/generated/prisma/client";
import { economics, type EconomicsConfig } from "@/config/economics";
import { writeAuditEvent, type AuditInput, type Tx } from "@/domains/audit/audit";
import type { IdentityDeps, RequestContext } from "@/domains/identity/accounts";
import { accounts, post } from "@/domains/payments/ledger";
import type { PaymentsProvider } from "@/domains/payments/provider";
import { applyBps } from "@/domains/pricing/pricing";
import { raiseFraudSignal, strongLinksBetween } from "@/domains/trust/linkage";

const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const MAX_PROVIDER_ATTEMPTS = 10;

export const normalizeReferralCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

function generateCode() {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

/** The user's share code, created on first use. */
export async function ensureReferralCode(db: Db, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } });
    if (user.referralCode) return user.referralCode;
    try {
      await db.user.updateMany({ where: { id: userId, referralCode: null }, data: { referralCode: generateCode() } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
  }
  throw new Error("Could not allocate a referral code");
}

/** The active account behind a share code, for the signup page and attribution. */
export async function findReferrer(db: Db | Tx, code: string) {
  const normalized = normalizeReferralCode(code);
  if (normalized.length !== CODE_LENGTH) return null;
  return db.user.findFirst({ where: { referralCode: normalized, status: "ACTIVE" }, select: { id: true, displayName: true } });
}

/** Attributes a new account to its referrer at signup. Unknown codes are ignored. */
export async function recordReferral(tx: Tx, input: { refereeUserId: string; code: string; ipHash?: string | null }) {
  const referrer = await findReferrer(tx, input.code);
  if (!referrer || referrer.id === input.refereeUserId) return null;
  const referral = await tx.referral.create({
    data: { referrerUserId: referrer.id, refereeUserId: input.refereeUserId, code: normalizeReferralCode(input.code) },
  });
  await writeAuditEvent(tx, {
    actorUserId: input.refereeUserId,
    actorType: "USER",
    action: "referral.created",
    subjectType: "Referral",
    subjectId: referral.id,
    after: { referrerUserId: referrer.id, refereeUserId: input.refereeUserId },
    ipHash: input.ipHash,
  });
  return referral;
}

/**
 * 5% of the sale (owner decision B2), on the order's fee snapshot. A partial
 * refund reduces what was actually sold for. Never more than the fees collected
 * when REFERRAL_CAP_AT_PLATFORM_FEE is on.
 */
export function earningForOrder(
  order: Pick<Order, "buyerPriceCents" | "askingPriceCents" | "platformFeeCents">,
  refundCents: number,
  config: EconomicsConfig = economics,
) {
  let gross: number;
  switch (config.referralBasis) {
    case "BUYER_PRICE":
      gross = order.buyerPriceCents;
      break;
    case "ASKING_PRICE":
      gross = order.askingPriceCents;
      break;
    default: {
      const exhaustive: never = config.referralBasis;
      throw new Error(`Unknown referral basis: ${String(exhaustive)}`);
    }
  }
  const basisCents = Math.max(0, gross - refundCents);
  const uncapped = applyBps(basisCents, config.referralBps);
  const cappedAtFee = config.referralCapAtPlatformFee && uncapped > order.platformFeeCents;
  return {
    rateBps: config.referralBps,
    basis: config.referralBasis,
    basisCents,
    amountCents: cappedAtFee ? order.platformFeeCents : uncapped,
    cappedAtFee,
  };
}

/**
 * Accrues the referrer's share when a recruit's sale is released. The money
 * moves from platform revenue to the referrer's payable account. Sales to the
 * referrer or a linked account, and recruits linked to their referrer, are
 * frozen for staff review instead.
 */
export async function accrueReferralEarning(
  tx: Tx,
  deps: { economics?: EconomicsConfig; now: Date },
  order: Order,
  refundCents: number,
): Promise<ReferralEarning | null> {
  const referral = await tx.referral.findUnique({ where: { refereeUserId: order.sellerUserId } });
  if (!referral) return null;
  const config = deps.economics ?? economics;
  const earning = earningForOrder(order, refundCents, config);
  if (earning.amountCents === 0) return null;

  const reasons: string[] = [];
  const evidence: Record<string, unknown> = {
    referrerUserId: referral.referrerUserId,
    sellerUserId: order.sellerUserId,
    buyerUserId: order.buyerUserId,
  };
  if (order.buyerUserId === referral.referrerUserId) {
    reasons.push("The referrer bought this item from their recruit.");
  } else {
    const buyerLinks = await strongLinksBetween(tx, order.buyerUserId, referral.referrerUserId);
    if (buyerLinks.length) {
      reasons.push("The buyer is linked to the referrer.");
      evidence.buyerReferrerSignals = buyerLinks;
    }
  }
  const recruitLinks = await strongLinksBetween(tx, order.sellerUserId, referral.referrerUserId);
  if (recruitLinks.length) {
    reasons.push("The recruit is linked to the referrer (possibly the same person).");
    evidence.recruitReferrerSignals = recruitLinks;
  }
  const frozen = reasons.length > 0;

  const created = await tx.referralEarning.create({
    data: {
      referralId: referral.id,
      orderId: order.id,
      ...earning,
      platformFeeCents: order.platformFeeCents,
      status: frozen ? "FROZEN" : "PENDING",
      frozenReason: frozen ? reasons.join(" ") : null,
      payableAt: new Date(deps.now.getTime() + config.referralHoldDays * DAY_MS),
    },
  });
  await post(tx, [
    {
      debit: accounts.platformRevenue(),
      credit: accounts.referralPayable(referral.referrerUserId),
      amountCents: created.amountCents,
      memo: "Referral share of the platform fee",
      orderId: order.id,
      referralEarningId: created.id,
    },
  ]);
  if (!referral.firstSaleOrderId) {
    await tx.referral.update({ where: { id: referral.id }, data: { firstSaleOrderId: order.id } });
  }
  if (frozen) {
    await raiseFraudSignal(tx, { detector: "REFERRAL_ABUSE", subjectType: "Order", subjectId: order.id, score: 75, evidence });
  }
  await writeAuditEvent(tx, {
    actorType: "SYSTEM",
    action: "referral.earning_accrued",
    subjectType: "ReferralEarning",
    subjectId: created.id,
    after: {
      orderId: order.id,
      referrerUserId: referral.referrerUserId,
      amountCents: created.amountCents,
      basis: created.basis,
      basisCents: created.basisCents,
      cappedAtFee: created.cappedAtFee,
      status: created.status,
      frozenReason: created.frozenReason,
    },
  });
  return created;
}

type ClawbackActor = Pick<AuditInput, "actorUserId" | "actorType" | "ipHash">;

/** Reverses an unpaid earning. Earnings already in a payout can't be clawed back here. */
async function clawBack(tx: Tx, earningId: string, reason: string, actor: ClawbackActor): Promise<boolean> {
  const earning = await tx.referralEarning.findUnique({ where: { id: earningId }, include: { referral: true } });
  if (!earning || earning.payoutId || !["PENDING", "FROZEN", "PAYABLE"].includes(earning.status)) return false;
  const updated = await tx.referralEarning.updateMany({
    where: { id: earning.id, status: earning.status, payoutId: null },
    data: { status: "CLAWED_BACK", clawbackReason: reason },
  });
  if (updated.count !== 1) return false;
  await post(tx, [
    {
      debit: accounts.referralPayable(earning.referral.referrerUserId),
      credit: accounts.platformRevenue(),
      amountCents: earning.amountCents,
      memo: `Referral clawback: ${reason}`,
      orderId: earning.orderId,
      referralEarningId: earning.id,
    },
  ]);
  await writeAuditEvent(tx, {
    ...actor,
    action: "referral.earning_clawed_back",
    subjectType: "ReferralEarning",
    subjectId: earning.id,
    before: { status: earning.status },
    after: { status: "CLAWED_BACK", reason, amountCents: earning.amountCents },
  });
  return true;
}

/** A chargeback after release takes back any unpaid referral share for that order. */
export async function clawBackOrderEarnings(tx: Tx, orderId: string, reason: string): Promise<number> {
  const earnings = await tx.referralEarning.findMany({ where: { orderId }, select: { id: true } });
  let count = 0;
  for (const e of earnings) if (await clawBack(tx, e.id, reason, { actorType: "SYSTEM" })) count++;
  return count;
}

/** Forfeits everything a referrer hasn't been paid yet (used when their account is banned). */
export async function forfeitUnpaidEarnings(tx: Tx, referrerUserId: string, reason: string, actor: ClawbackActor): Promise<number> {
  const earnings = await tx.referralEarning.findMany({
    where: { referral: { referrerUserId }, status: { in: ["PENDING", "FROZEN", "PAYABLE"] }, payoutId: null },
    select: { id: true },
  });
  let count = 0;
  for (const e of earnings) if (await clawBack(tx, e.id, reason, actor)) count++;
  return count;
}

export type FrozenDecisionResult = { ok: true } | { ok: false; reason: "NOT_STAFF" | "NOT_FOUND" | "NOT_FROZEN" | "REASON_REQUIRED" };

/**
 * Staff decide a frozen earning: RELEASE puts it back on the normal schedule;
 * FORFEIT claws it back and records a FEE_FORFEIT action against the referrer.
 */
export async function decideFrozenEarning(
  deps: IdentityDeps,
  input: { actorId: string; earningId: string; decision: "RELEASE" | "FORFEIT"; reason: string },
  ctx: RequestContext = {},
): Promise<FrozenDecisionResult> {
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, reason: "REASON_REQUIRED" };
  const result = await deps.db.$transaction(async (tx) => {
    const actor = await tx.user.findUnique({ where: { id: input.actorId }, select: { role: true } });
    if (!actor || (actor.role !== "OWNER" && actor.role !== "MODERATOR")) return { ok: false, reason: "NOT_STAFF" } as const;
    const earning = await tx.referralEarning.findUnique({
      where: { id: input.earningId },
      include: { referral: { include: { referrer: { select: { id: true, email: true } } } } },
    });
    if (!earning) return { ok: false, reason: "NOT_FOUND" } as const;
    if (earning.status !== "FROZEN") return { ok: false, reason: "NOT_FROZEN" } as const;
    const audit = { actorUserId: input.actorId, actorType: "ADMIN" as const, ipHash: ctx.ipHash };
    switch (input.decision) {
      case "RELEASE": {
        await tx.referralEarning.update({ where: { id: earning.id }, data: { status: "PENDING" } });
        await writeAuditEvent(tx, {
          ...audit,
          action: "referral.earning_unfrozen",
          subjectType: "ReferralEarning",
          subjectId: earning.id,
          before: { status: "FROZEN", frozenReason: earning.frozenReason },
          after: { status: "PENDING", reason },
        });
        return { ok: true, email: null } as const;
      }
      case "FORFEIT": {
        await clawBack(tx, earning.id, `Forfeited: ${reason}`, audit);
        const action = await tx.enforcementAction.create({
          data: { userId: earning.referral.referrerUserId, type: "FEE_FORFEIT", reason, actorId: input.actorId },
        });
        await writeAuditEvent(tx, {
          ...audit,
          action: "enforcement.issued",
          subjectType: "User",
          subjectId: earning.referral.referrerUserId,
          after: { enforcementId: action.id, type: "FEE_FORFEIT", reason, referralEarningId: earning.id, amountCents: earning.amountCents },
        });
        return { ok: true, email: earning.referral.referrer.email } as const;
      }
      default: {
        const exhaustive: never = input.decision;
        throw new Error(`Unknown decision: ${String(exhaustive)}`);
      }
    }
  });
  if (!result.ok) return result;
  if (result.email) {
    await deps.mailer.send({
      to: result.email,
      subject: "A referral earning was forfeited",
      text: `After review, a referral earning on your account was forfeited:\n\n${reason}\n\nReferral earnings are only paid on genuine sales between unrelated people. Reply to this email to appeal.`,
    });
  }
  return { ok: true };
}

export interface ReferralJobDeps {
  db: Db;
  payments: PaymentsProvider;
  economics?: EconomicsConfig;
  now?: () => Date;
}

export interface ReferralJobReport {
  madePayable: number;
  payoutsCreated: number;
  payoutsPaid: number;
}

/**
 * Moves earnings past the chargeback window to PAYABLE, then pays each
 * eligible referrer (active, ID-verified, with a payout account) once their
 * payable total reaches the minimum. Safe to run repeatedly.
 */
export async function runReferralJobs(deps: ReferralJobDeps): Promise<ReferralJobReport> {
  const now = deps.now ? deps.now() : new Date();
  const config = deps.economics ?? economics;
  const report: ReferralJobReport = { madePayable: 0, payoutsCreated: 0, payoutsPaid: 0 };

  const due = await deps.db.referralEarning.findMany({
    where: {
      status: "PENDING",
      payableAt: { lte: now },
      order: { disputes: { none: { isChargeback: true, status: { not: "RESOLVED" } } } },
    },
    select: { id: true },
    take: 1000,
  });
  if (due.length) {
    report.madePayable = await deps.db.$transaction(async (tx) => {
      const { count } = await tx.referralEarning.updateMany({
        where: { id: { in: due.map((d) => d.id) }, status: "PENDING" },
        data: { status: "PAYABLE" },
      });
      await writeAuditEvent(tx, {
        actorType: "SYSTEM",
        action: "referral.earnings_payable",
        subjectType: "ReferralEarning",
        after: { count, earningIds: due.map((d) => d.id) },
      });
      return count;
    });
  }

  const payable = await deps.db.referralEarning.findMany({
    where: { status: "PAYABLE", payoutId: null },
    select: { id: true, amountCents: true, referral: { select: { referrerUserId: true } } },
    take: 5000,
  });
  const byReferrer = new Map<string, { ids: string[]; total: number }>();
  for (const e of payable) {
    const entry = byReferrer.get(e.referral.referrerUserId) ?? { ids: [], total: 0 };
    entry.ids.push(e.id);
    entry.total += e.amountCents;
    byReferrer.set(e.referral.referrerUserId, entry);
  }
  for (const [referrerUserId, { ids, total }] of byReferrer) {
    if (total < config.referralMinPayoutCents) continue;
    const eligibility = await payoutEligibility(deps.db, referrerUserId);
    if (!eligibility.ok) continue;
    const payoutId = await deps.db.$transaction(async (tx) => {
      const payout = await tx.referralPayout.create({
        data: { referrerUserId, amountCents: total, idempotencyKey: `referral-payout:${randomUUID()}`, destinationAccountId: eligibility.accountId },
      });
      const claimed = await tx.referralEarning.updateMany({
        where: { id: { in: ids }, status: "PAYABLE", payoutId: null },
        data: { payoutId: payout.id },
      });
      if (claimed.count !== ids.length) throw new Error("Referral earnings changed while creating a payout");
      return payout.id;
    });
    report.payoutsCreated++;
    if (await executeReferralPayout(deps, payoutId)) report.payoutsPaid++;
  }

  const retries = await deps.db.referralPayout.findMany({
    where: { status: "PENDING", attempts: { gt: 0, lt: MAX_PROVIDER_ATTEMPTS } },
    select: { id: true },
    take: 100,
  });
  for (const r of retries) if (await executeReferralPayout(deps, r.id)) report.payoutsPaid++;
  return report;
}

export type PayoutEligibility =
  | { ok: true; accountId: string }
  | { ok: false; reason: "ACCOUNT_RESTRICTED" | "ID_NOT_VERIFIED" | "NO_PAYOUT_ACCOUNT" };

/** Referral earnings need ID verification (BUILD_PLAN 5.2) and a Stripe payout account. */
export async function payoutEligibility(db: Db | Tx, userId: string): Promise<PayoutEligibility> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      status: true,
      identityVerification: { select: { status: true } },
      ownedStorefronts: { where: { payoutsEnabled: true, stripeAccountId: { not: null } }, select: { stripeAccountId: true }, take: 1 },
    },
  });
  if (!user || user.status !== "ACTIVE") return { ok: false, reason: "ACCOUNT_RESTRICTED" };
  if (user.identityVerification?.status !== "VERIFIED") return { ok: false, reason: "ID_NOT_VERIFIED" };
  const accountId = user.ownedStorefronts[0]?.stripeAccountId;
  if (!accountId) return { ok: false, reason: "NO_PAYOUT_ACCOUNT" };
  return { ok: true, accountId };
}

/** Sends one payout from the platform balance. Cancelled (REVERSED) if the referrer was restricted meanwhile. */
export async function executeReferralPayout(deps: ReferralJobDeps, payoutId: string): Promise<boolean> {
  const payout = await deps.db.referralPayout.findUniqueOrThrow({ where: { id: payoutId } });
  if (payout.status !== "PENDING") return payout.status === "PAID";
  const referrer = await deps.db.user.findUniqueOrThrow({ where: { id: payout.referrerUserId }, select: { status: true } });
  if (referrer.status !== "ACTIVE") {
    await deps.db.$transaction(async (tx) => {
      await tx.referralEarning.updateMany({ where: { payoutId: payout.id, status: "PAYABLE" }, data: { payoutId: null } });
      await tx.referralPayout.update({ where: { id: payout.id }, data: { status: "REVERSED", lastError: "Referrer account restricted" } });
      await writeAuditEvent(tx, {
        actorType: "SYSTEM",
        action: "referral.payout_cancelled",
        subjectType: "ReferralPayout",
        subjectId: payout.id,
        after: { referrerUserId: payout.referrerUserId, amountCents: payout.amountCents, reason: "Referrer account restricted" },
      });
    });
    return false;
  }
  try {
    const result = await deps.payments.createTransfer({
      accountId: payout.destinationAccountId,
      amountCents: payout.amountCents,
      transferGroup: `referrals_${payout.referrerUserId}`,
      idempotencyKey: payout.idempotencyKey,
    });
    await deps.db.$transaction(async (tx) => {
      await tx.referralPayout.update({
        where: { id: payout.id },
        data: { status: "PAID", stripeTransferId: result.transferId, attempts: { increment: 1 }, lastError: null },
      });
      await tx.referralEarning.updateMany({ where: { payoutId: payout.id, status: "PAYABLE" }, data: { status: "PAID" } });
      await post(tx, [
        {
          debit: accounts.referralPayable(payout.referrerUserId),
          credit: accounts.cash(),
          amountCents: payout.amountCents,
          memo: "Referral payout to the referrer's payout account",
        },
      ]);
      await writeAuditEvent(tx, {
        actorType: "SYSTEM",
        action: "referral.payout_paid",
        subjectType: "ReferralPayout",
        subjectId: payout.id,
        after: { referrerUserId: payout.referrerUserId, amountCents: payout.amountCents, providerId: result.transferId },
      });
    });
    return true;
  } catch (err) {
    await deps.db.referralPayout.update({
      where: { id: payout.id },
      data: { attempts: { increment: 1 }, lastError: String(err instanceof Error ? err.message : err).slice(0, 500) },
    });
    return false;
  }
}
