import type { EnforcementType, FraudSignalStatus, UserRole } from "@/generated/prisma/enums";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";
import type { IdentityDeps, RequestContext } from "@/domains/identity/accounts";
import { recomputeVolumeBadges } from "@/domains/growth/badges";
import { cancelOpenAuction } from "@/domains/auctions/lifecycle";
import { forfeitUnpaidEarnings } from "@/domains/growth/referrals";
import { recordListingOutcome } from "@/domains/listings/outcomes";
import { DAY_MS } from "@/domains/orders/deps";

/** Types staff issue from the dashboard. BID_VOID and FEE_FORFEIT are issued by the auction and referral code. */
export const MANUAL_ENFORCEMENT_TYPES = ["WARNING", "LISTING_REMOVED", "BADGE_REVOKED", "SUSPENSION", "BAN"] as const;
export type ManualEnforcementType = (typeof MANUAL_ENFORCEMENT_TYPES)[number];

/** Account-level actions: owner only, and the owner re-enters their password (checked by the caller). */
export const ACCOUNT_ACTIONS: ReadonlySet<EnforcementType> = new Set(["SUSPENSION", "BAN"]);

export const MAX_SUSPENSION_DAYS = 365;

const ACTIVE_ORDER_STATUSES = ["CREATED", "PAID_HELD", "SHIPPED", "DELIVERED", "DISPUTED"] as const;

export type EnforcementInput = {
  actorId: string;
  userId: string;
  type: ManualEnforcementType;
  reason: string;
  fraudSignalId?: string | null;
  listingId?: string | null;
  userBadgeId?: string | null;
  suspensionDays?: number | null;
};

export type EnforcementResult =
  | { ok: true; enforcementId: string; listingsRemoved: number }
  | {
      ok: false;
      reason:
        | "NOT_STAFF"
        | "OWNER_ONLY"
        | "SELF_ACTION"
        | "TARGET_IS_OWNER"
        | "USER_NOT_FOUND"
        | "REASON_REQUIRED"
        | "LISTING_NOT_REMOVABLE"
        | "LISTING_HAS_ACTIVE_ORDER"
        | "BADGE_NOT_FOUND"
        | "INVALID_DURATION"
        | "ALREADY_RESTRICTED";
    };

const NOTICE: Record<ManualEnforcementType, (reason: string, extra: string) => { subject: string; text: string }> = {
  WARNING: (reason) => ({
    subject: "A warning on your Used Artifacts account",
    text: `Our trust and safety team reviewed activity on your account and is issuing a warning:\n\n${reason}\n\nRepeated issues can lead to suspension. Reply to this email to appeal.`,
  }),
  LISTING_REMOVED: (reason, extra) => ({
    subject: "We removed one of your listings",
    text: `We removed your listing "${extra}":\n\n${reason}\n\nReply to this email to appeal.`,
  }),
  BADGE_REVOKED: (reason, extra) => ({
    subject: "A badge was removed from your account",
    text: `We removed the "${extra}" badge from your account:\n\n${reason}\n\nReply to this email to appeal.`,
  }),
  SUSPENSION: (reason, extra) => ({
    subject: "Your Used Artifacts account is suspended",
    text: `Your account is suspended ${extra}:\n\n${reason}\n\nYour listings are hidden and you can't sign in until then. Orders already paid are handled by our team. Reply to this email to appeal.`,
  }),
  BAN: (reason) => ({
    subject: "Your Used Artifacts account is closed",
    text: `Your account has been closed:\n\n${reason}\n\nYour listings were removed. Orders already paid are handled by our team. Reply to this email to appeal.`,
  }),
};

const clock = (deps: { now?: () => Date }) => (deps.now ? deps.now() : new Date());

export async function staffRole(tx: Tx, userId: string): Promise<UserRole | null> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user && (user.role === "OWNER" || user.role === "MODERATOR") ? user.role : null;
}

async function removeListing(tx: Tx, listingId: string, now: Date) {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId }, select: { status: true } });
  await tx.listing.update({ where: { id: listingId }, data: { status: "REMOVED" } });
  await cancelOpenAuction(tx, listingId, now);
  await tx.complianceReview.updateMany({
    where: { listingId, status: "OPEN" },
    data: { status: "REJECTED", decision: "REMOVED", notes: "Removed by trust and safety", decidedAt: now },
  });
  if (listing.status === "LIVE") await recordListingOutcome(tx, { listingId, outcome: "REMOVED", closedAt: now });
}

/**
 * Staff enforcement against an account. Every action is recorded (append-only),
 * audited, emailed to the user, and can be lifted on appeal.
 */
export async function takeEnforcementAction(
  deps: IdentityDeps,
  input: EnforcementInput,
  ctx: RequestContext = {},
): Promise<EnforcementResult> {
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, reason: "REASON_REQUIRED" };
  if (input.actorId === input.userId) return { ok: false, reason: "SELF_ACTION" };
  if (input.type === "SUSPENSION") {
    const days = input.suspensionDays ?? 0;
    if (!Number.isInteger(days) || days < 1 || days > MAX_SUSPENSION_DAYS) return { ok: false, reason: "INVALID_DURATION" };
  }
  const now = clock(deps);

  const result = await deps.db.$transaction(async (tx) => {
    const role = await staffRole(tx, input.actorId);
    if (!role) return { ok: false, reason: "NOT_STAFF" } as const;
    if (ACCOUNT_ACTIONS.has(input.type) && role !== "OWNER") return { ok: false, reason: "OWNER_ONLY" } as const;
    const target = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true, role: true, status: true } });
    if (!target) return { ok: false, reason: "USER_NOT_FOUND" } as const;
    if (target.role === "OWNER") return { ok: false, reason: "TARGET_IS_OWNER" } as const;

    let noticeExtra = "";
    let listingsRemoved = 0;
    const type = input.type;
    switch (type) {
      case "WARNING":
        break;
      case "LISTING_REMOVED": {
        const listing = input.listingId
          ? await tx.listing.findFirst({ where: { id: input.listingId, sellerUserId: target.id }, select: { id: true, status: true, title: true } })
          : null;
        if (!listing || !["LIVE", "PENDING_REVIEW"].includes(listing.status)) return { ok: false, reason: "LISTING_NOT_REMOVABLE" } as const;
        if (await tx.order.count({ where: { listingId: listing.id, status: { in: [...ACTIVE_ORDER_STATUSES] } } })) {
          return { ok: false, reason: "LISTING_HAS_ACTIVE_ORDER" } as const;
        }
        await removeListing(tx, listing.id, now);
        listingsRemoved = 1;
        noticeExtra = listing.title;
        break;
      }
      case "BADGE_REVOKED": {
        const award = input.userBadgeId
          ? await tx.userBadge.findFirst({ where: { id: input.userBadgeId, userId: target.id, revokedAt: null }, include: { badge: true } })
          : null;
        if (!award) return { ok: false, reason: "BADGE_NOT_FOUND" } as const;
        await tx.userBadge.update({ where: { id: award.id }, data: { revokedAt: now } });
        noticeExtra = award.badge.name;
        break;
      }
      case "SUSPENSION":
      case "BAN": {
        if (target.status === "BANNED" || (type === "SUSPENSION" && target.status === "SUSPENDED")) {
          return { ok: false, reason: "ALREADY_RESTRICTED" } as const;
        }
        await tx.user.update({ where: { id: target.id }, data: { status: type === "BAN" ? "BANNED" : "SUSPENDED" } });
        await tx.session.deleteMany({ where: { userId: target.id } });
        await tx.storefront.updateMany({
          where: { ownerUserId: target.id, status: type === "BAN" ? { in: ["ACTIVE", "SUSPENDED"] } : "ACTIVE" },
          data: { status: type === "BAN" ? "CLOSED" : "SUSPENDED" },
        });
        if (type === "BAN") {
          const removable = await tx.listing.findMany({
            where: {
              sellerUserId: target.id,
              status: { in: ["LIVE", "PENDING_REVIEW"] },
              orders: { none: { status: { in: [...ACTIVE_ORDER_STATUSES] } } },
            },
            select: { id: true },
          });
          for (const l of removable) await removeListing(tx, l.id, now);
          listingsRemoved = removable.length;
          await tx.enforcementAction.updateMany({
            where: { userId: target.id, type: "SUSPENSION", liftedAt: null },
            data: { liftedAt: now, liftedById: input.actorId, liftReason: "Superseded by a ban" },
          });
          await forfeitUnpaidEarnings(tx, target.id, "Account banned", { actorUserId: input.actorId, actorType: "ADMIN", ipHash: ctx.ipHash });
        } else {
          noticeExtra = `until ${new Date(now.getTime() + input.suspensionDays! * DAY_MS).toISOString().slice(0, 10)}`;
        }
        break;
      }
      default: {
        const exhaustive: never = type;
        throw new Error(`Unhandled enforcement type: ${String(exhaustive)}`);
      }
    }

    const action = await tx.enforcementAction.create({
      data: {
        userId: target.id,
        type,
        reason,
        actorId: input.actorId,
        fraudSignalId: input.fraudSignalId ?? null,
        listingId: type === "LISTING_REMOVED" ? input.listingId : null,
        userBadgeId: type === "BADGE_REVOKED" ? input.userBadgeId : null,
        expiresAt: type === "SUSPENSION" ? new Date(now.getTime() + input.suspensionDays! * DAY_MS) : null,
      },
    });
    if (input.fraudSignalId) {
      await tx.fraudSignal.updateMany({
        where: { id: input.fraudSignalId, status: "OPEN" },
        data: { status: "CONFIRMED", reviewedById: input.actorId, reviewedAt: now, reviewNotes: reason },
      });
    }
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "enforcement.issued",
      subjectType: "User",
      subjectId: target.id,
      before: { status: target.status },
      after: {
        enforcementId: action.id,
        type,
        reason,
        listingId: action.listingId,
        userBadgeId: action.userBadgeId,
        expiresAt: action.expiresAt?.toISOString() ?? null,
        fraudSignalId: action.fraudSignalId,
        listingsRemoved,
      },
      ipHash: ctx.ipHash,
    });
    return { ok: true, enforcementId: action.id, listingsRemoved, email: target.email, noticeExtra } as const;
  });
  if (!result.ok) return result;
  await deps.mailer.send({ to: result.email, ...NOTICE[input.type](reason, result.noticeExtra) });
  return { ok: true, enforcementId: result.enforcementId, listingsRemoved: result.listingsRemoved };
}

export type LiftResult =
  | { ok: true }
  | { ok: false; reason: "NOT_STAFF" | "OWNER_ONLY" | "NOT_FOUND" | "ALREADY_LIFTED" | "REASON_REQUIRED" | "NOT_LIFTABLE" };

async function restoreAccess(tx: Tx, userId: string) {
  const stillRestricted = await tx.enforcementAction.count({
    where: { userId, type: { in: ["SUSPENSION", "BAN"] }, liftedAt: null },
  });
  if (stillRestricted > 0) return;
  await tx.user.update({ where: { id: userId }, data: { status: "ACTIVE" } });
  await tx.storefront.updateMany({ where: { ownerUserId: userId, status: { in: ["SUSPENDED", "CLOSED"] } }, data: { status: "ACTIVE" } });
}

/** Actions that can't be undone by lifting: removed listings are resubmitted, voided bids and forfeited fees stay. */
export const UNLIFTABLE_ACTIONS: ReadonlySet<EnforcementType> = new Set(["LISTING_REMOVED", "BID_VOID", "FEE_FORFEIT"]);

type LiftTxResult = Exclude<LiftResult, { ok: true }> | { ok: true; email: string; type: EnforcementType };

/** Lifts an action inside the caller's transaction (also used when an appeal is overturned). */
export async function liftEnforcementActionTx(
  tx: Tx,
  input: { actorId: string; enforcementId: string; reason: string; now: Date },
  ctx: RequestContext = {},
): Promise<LiftTxResult> {
  const role = await staffRole(tx, input.actorId);
  if (!role) return { ok: false, reason: "NOT_STAFF" };
  const action = await tx.enforcementAction.findUnique({ where: { id: input.enforcementId }, include: { user: { select: { email: true } } } });
  if (!action) return { ok: false, reason: "NOT_FOUND" };
  if (action.liftedAt) return { ok: false, reason: "ALREADY_LIFTED" };
  if (ACCOUNT_ACTIONS.has(action.type) && role !== "OWNER") return { ok: false, reason: "OWNER_ONLY" };
  if (UNLIFTABLE_ACTIONS.has(action.type)) return { ok: false, reason: "NOT_LIFTABLE" };
  await tx.enforcementAction.update({
    where: { id: action.id },
    data: { liftedAt: input.now, liftedById: input.actorId, liftReason: input.reason },
  });
  if (action.type === "BADGE_REVOKED" && action.userBadgeId) {
    await tx.userBadge.update({ where: { id: action.userBadgeId }, data: { revokedAt: null } });
  }
  if (action.type === "SUSPENSION" || action.type === "BAN") await restoreAccess(tx, action.userId);
  await writeAuditEvent(tx, {
    actorUserId: input.actorId,
    actorType: "ADMIN",
    action: "enforcement.lifted",
    subjectType: "User",
    subjectId: action.userId,
    after: { enforcementId: action.id, type: action.type, reason: input.reason },
    ipHash: ctx.ipHash,
  });
  return { ok: true, email: action.user.email, type: action.type };
}

/** Overturns an action on appeal. Removed listings stay removed (the seller resubmits); badges are restored. */
export async function liftEnforcementAction(
  deps: IdentityDeps,
  input: { actorId: string; enforcementId: string; reason: string },
  ctx: RequestContext = {},
): Promise<LiftResult> {
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, reason: "REASON_REQUIRED" };
  const now = clock(deps);
  const result = await deps.db.$transaction((tx) => liftEnforcementActionTx(tx, { ...input, reason, now }, ctx));
  if (!result.ok) return result;
  if (result.type === "SUSPENSION" || result.type === "BAN") {
    await deps.mailer.send({
      to: result.email,
      subject: "Your Used Artifacts account is restored",
      text: `We reviewed your appeal and restored your account:\n\n${reason}\n\nYou can sign in again.`,
    });
  }
  return { ok: true };
}

/** Ends suspensions whose time is up (run from the scheduled job). */
export async function liftExpiredSuspensions(deps: { db: IdentityDeps["db"]; now?: () => Date }): Promise<number> {
  const now = clock(deps);
  const due = await deps.db.enforcementAction.findMany({
    where: { type: "SUSPENSION", liftedAt: null, expiresAt: { lte: now } },
    select: { id: true, userId: true },
    take: 200,
  });
  for (const action of due) {
    await deps.db.$transaction(async (tx) => {
      const lifted = await tx.enforcementAction.updateMany({
        where: { id: action.id, liftedAt: null },
        data: { liftedAt: now, liftReason: "Suspension period ended" },
      });
      if (lifted.count !== 1) return;
      await restoreAccess(tx, action.userId);
      await writeAuditEvent(tx, {
        actorType: "SYSTEM",
        action: "enforcement.expired",
        subjectType: "User",
        subjectId: action.userId,
        after: { enforcementId: action.id },
      });
    });
  }
  return due.length;
}

export type ReviewSignalResult = { ok: true } | { ok: false; reason: "NOT_STAFF" | "NOT_FOUND" | "ALREADY_REVIEWED" | "NOTES_REQUIRED" };

/** Dismisses or confirms a fraud signal without (or before) enforcement. */
export async function reviewFraudSignal(
  deps: { db: IdentityDeps["db"]; now?: () => Date },
  input: { actorId: string; signalId: string; status: Exclude<FraudSignalStatus, "OPEN">; notes: string },
  ctx: RequestContext = {},
): Promise<ReviewSignalResult> {
  const notes = input.notes.trim();
  if (notes.length < 5) return { ok: false, reason: "NOTES_REQUIRED" };
  return deps.db.$transaction(async (tx) => {
    if (!(await staffRole(tx, input.actorId))) return { ok: false, reason: "NOT_STAFF" } as const;
    const signal = await tx.fraudSignal.findUnique({ where: { id: input.signalId } });
    if (!signal) return { ok: false, reason: "NOT_FOUND" } as const;
    const updated = await tx.fraudSignal.updateMany({
      where: { id: signal.id, status: "OPEN" },
      data: { status: input.status, reviewedById: input.actorId, reviewedAt: clock(deps), reviewNotes: notes },
    });
    if (updated.count !== 1) return { ok: false, reason: "ALREADY_REVIEWED" } as const;
    const linked = await tx.fraudSignalOrder.findMany({ where: { signalId: signal.id }, select: { orderId: true } });
    const orderIds = [...(signal.subjectType === "Order" ? [signal.subjectId] : []), ...linked.map((l) => l.orderId)];
    if (orderIds.length > 0) {
      const orders = await tx.order.findMany({ where: { id: { in: orderIds } }, select: { sellerUserId: true, buyerUserId: true } });
      for (const userId of new Set(orders.flatMap((o) => [o.sellerUserId, o.buyerUserId]))) await recomputeVolumeBadges(tx, userId);
    }
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: input.status === "CONFIRMED" ? "fraud.signal_confirmed" : "fraud.signal_dismissed",
      subjectType: "FraudSignal",
      subjectId: signal.id,
      after: { detector: signal.detector, notes },
      ipHash: ctx.ipHash,
    });
    return { ok: true } as const;
  });
}

export type SetRoleResult = { ok: true } | { ok: false; reason: "OWNER_ONLY" | "SELF_ACTION" | "USER_NOT_FOUND" | "TARGET_IS_OWNER" | "UNCHANGED" };

/** Owner promotes or demotes moderators. OWNER is never granted or removed here (the Proprietor is assigned once). */
export async function setUserRole(
  deps: { db: IdentityDeps["db"] },
  input: { actorId: string; userId: string; role: "USER" | "MODERATOR" },
  ctx: RequestContext = {},
): Promise<SetRoleResult> {
  if (input.actorId === input.userId) return { ok: false, reason: "SELF_ACTION" };
  return deps.db.$transaction(async (tx) => {
    if ((await staffRole(tx, input.actorId)) !== "OWNER") return { ok: false, reason: "OWNER_ONLY" } as const;
    const target = await tx.user.findUnique({ where: { id: input.userId }, select: { role: true } });
    if (!target) return { ok: false, reason: "USER_NOT_FOUND" } as const;
    if (target.role === "OWNER") return { ok: false, reason: "TARGET_IS_OWNER" } as const;
    if (target.role === input.role) return { ok: false, reason: "UNCHANGED" } as const;
    await tx.user.update({ where: { id: input.userId }, data: { role: input.role } });
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "user.role_changed",
      subjectType: "User",
      subjectId: input.userId,
      before: { role: target.role },
      after: { role: input.role },
      ipHash: ctx.ipHash,
    });
    return { ok: true } as const;
  });
}
