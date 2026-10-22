import type { EnforcementType } from "@/generated/prisma/enums";
import { writeAuditEvent } from "@/domains/audit/audit";
import type { IdentityDeps, RequestContext } from "@/domains/identity/accounts";
import { liftEnforcementActionTx, staffRole, UNLIFTABLE_ACTIONS } from "./enforcement";

export const APPEAL_MIN_CHARS = 20;
export const APPEAL_MAX_CHARS = 4000;

export type SubmitAppealResult =
  | { ok: true; appealId: string }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_APPEALED" | "ALREADY_LIFTED" | "MESSAGE_LENGTH" };

/** A member appeals one action taken against their account. */
export async function submitAppeal(
  deps: { db: IdentityDeps["db"] },
  input: { userId: string; enforcementActionId: string; message: string },
  ctx: RequestContext = {},
): Promise<SubmitAppealResult> {
  const message = input.message.trim();
  if (message.length < APPEAL_MIN_CHARS || message.length > APPEAL_MAX_CHARS) return { ok: false, reason: "MESSAGE_LENGTH" };
  return deps.db.$transaction(async (tx) => {
    const action = await tx.enforcementAction.findUnique({
      where: { id: input.enforcementActionId },
      select: { id: true, userId: true, type: true, liftedAt: true, appeal: { select: { id: true } } },
    });
    if (!action || action.userId !== input.userId) return { ok: false, reason: "NOT_FOUND" } as const;
    if (action.appeal) return { ok: false, reason: "ALREADY_APPEALED" } as const;
    if (action.liftedAt) return { ok: false, reason: "ALREADY_LIFTED" } as const;
    const appeal = await tx.appeal.create({ data: { enforcementActionId: action.id, userId: input.userId, message } });
    await writeAuditEvent(tx, {
      actorUserId: input.userId,
      actorType: "USER",
      action: "appeal.submitted",
      subjectType: "Appeal",
      subjectId: appeal.id,
      after: { enforcementActionId: action.id, type: action.type },
      ipHash: ctx.ipHash,
    });
    return { ok: true, appealId: appeal.id } as const;
  });
}

export type DecideAppealResult =
  | { ok: true }
  | { ok: false; reason: "NOT_STAFF" | "NOT_FOUND" | "ALREADY_DECIDED" | "NOTES_REQUIRED" | "SELF_ACTION" | "OWNER_ONLY" };

const DECISION_TEXT: Record<"UPHOLD" | "OVERTURN", (type: EnforcementType) => string> = {
  UPHOLD: () => "We reviewed your appeal and the action stands.",
  OVERTURN: (type) =>
    UNLIFTABLE_ACTIONS.has(type)
      ? "We reviewed your appeal and agree with you. The action can't be undone automatically (for a removed listing, resubmit it), but it no longer counts against your account."
      : "We reviewed your appeal and reversed the action.",
};

/**
 * Staff decide an appeal. Overturning lifts the action in the same transaction
 * (suspensions and bans stay owner-only); actions that can't be lifted are
 * recorded as overturned so they stop counting against the member.
 */
export async function decideAppeal(
  deps: IdentityDeps,
  input: { actorId: string; appealId: string; decision: "UPHOLD" | "OVERTURN"; notes: string },
  ctx: RequestContext = {},
): Promise<DecideAppealResult> {
  const notes = input.notes.trim();
  if (notes.length < 5) return { ok: false, reason: "NOTES_REQUIRED" };
  const now = deps.now?.() ?? new Date();
  const result = await deps.db.$transaction(async (tx) => {
    if (!(await staffRole(tx, input.actorId))) return { ok: false, reason: "NOT_STAFF" } as const;
    const appeal = await tx.appeal.findUnique({
      where: { id: input.appealId },
      include: { enforcementAction: { select: { id: true, type: true, liftedAt: true } }, user: { select: { email: true } } },
    });
    if (!appeal) return { ok: false, reason: "NOT_FOUND" } as const;
    if (appeal.userId === input.actorId) return { ok: false, reason: "SELF_ACTION" } as const;
    if (appeal.status !== "OPEN") return { ok: false, reason: "ALREADY_DECIDED" } as const;
    const type = appeal.enforcementAction.type;
    if (input.decision === "OVERTURN" && !UNLIFTABLE_ACTIONS.has(type) && !appeal.enforcementAction.liftedAt) {
      const lifted = await liftEnforcementActionTx(
        tx,
        { actorId: input.actorId, enforcementId: appeal.enforcementActionId, reason: `Appeal overturned: ${notes}`, now },
        ctx,
      );
      if (!lifted.ok) {
        if (lifted.reason === "OWNER_ONLY") return { ok: false, reason: "OWNER_ONLY" } as const;
        if (lifted.reason !== "ALREADY_LIFTED") throw new Error(`Unexpected lift failure: ${lifted.reason}`);
      }
    }
    const updated = await tx.appeal.updateMany({
      where: { id: appeal.id, status: "OPEN" },
      data: { status: input.decision === "OVERTURN" ? "OVERTURNED" : "UPHELD", decidedById: input.actorId, decidedAt: now, decisionNotes: notes },
    });
    if (updated.count !== 1) return { ok: false, reason: "ALREADY_DECIDED" } as const;
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: input.decision === "OVERTURN" ? "appeal.overturned" : "appeal.upheld",
      subjectType: "Appeal",
      subjectId: appeal.id,
      after: { enforcementActionId: appeal.enforcementActionId, type, notes },
      ipHash: ctx.ipHash,
    });
    return { ok: true, email: appeal.user.email, type } as const;
  });
  if (!result.ok) return result;
  await deps.mailer.send({
    to: result.email,
    subject: "Your Used Artifacts appeal was reviewed",
    text: `${DECISION_TEXT[input.decision](result.type)}\n\n${notes}`,
  });
  return { ok: true };
}

/** Open appeals for the staff queue, oldest first. */
export async function openAppeals(db: IdentityDeps["db"], take = 100) {
  return db.appeal.findMany({
    where: { status: "OPEN" },
    orderBy: { createdAt: "asc" },
    take,
    include: {
      user: { select: { id: true, displayName: true, email: true } },
      enforcementAction: { select: { id: true, type: true, reason: true, createdAt: true, expiresAt: true } },
    },
  });
}
