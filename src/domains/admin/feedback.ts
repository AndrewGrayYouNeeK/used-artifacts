import type { Db } from "@/lib/db";
import type { FeedbackCategory, FeedbackStatus } from "@/generated/prisma/enums";
import { writeAuditEvent } from "@/domains/audit/audit";

export const FEEDBACK_DAILY_LIMIT = 10;
export const FEEDBACK_MAX_LENGTH = 5000;

export type SubmitFeedbackResult = { ok: true; feedbackId: string } | { ok: false; reason: "MESSAGE_REQUIRED" | "RATE_LIMITED" | "ACCOUNT_RESTRICTED" };

export async function submitFeedback(
  deps: { db: Db; now?: () => Date },
  input: { userId: string; category: FeedbackCategory; message: string; pagePath?: string | null },
  ctx: { ipHash?: string | null } = {},
): Promise<SubmitFeedbackResult> {
  const message = input.message.trim();
  if (message.length < 5 || message.length > FEEDBACK_MAX_LENGTH) return { ok: false, reason: "MESSAGE_REQUIRED" };
  const user = await deps.db.user.findUnique({ where: { id: input.userId }, select: { status: true } });
  if (!user || user.status !== "ACTIVE") return { ok: false, reason: "ACCOUNT_RESTRICTED" };
  const now = deps.now ? deps.now() : new Date();
  const recent = await deps.db.feedback.count({
    where: { userId: input.userId, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
  });
  if (recent >= FEEDBACK_DAILY_LIMIT) return { ok: false, reason: "RATE_LIMITED" };
  const pagePath = input.pagePath?.startsWith("/") ? input.pagePath.slice(0, 300) : null;
  const created = await deps.db.$transaction(async (tx) => {
    const row = await tx.feedback.create({ data: { userId: input.userId, category: input.category, message, pagePath } });
    await writeAuditEvent(tx, {
      actorUserId: input.userId,
      actorType: "USER",
      action: "feedback.submitted",
      subjectType: "Feedback",
      subjectId: row.id,
      after: { category: input.category, pagePath },
      ipHash: ctx.ipHash,
    });
    return row;
  });
  return { ok: true, feedbackId: created.id };
}

export type HandleFeedbackResult = { ok: true } | { ok: false; reason: "NOT_STAFF" | "NOT_FOUND" | "UNCHANGED" };

export async function handleFeedback(
  deps: { db: Db; now?: () => Date },
  input: { actorId: string; feedbackId: string; status: FeedbackStatus; notes: string },
  ctx: { ipHash?: string | null } = {},
): Promise<HandleFeedbackResult> {
  const actor = await deps.db.user.findUnique({ where: { id: input.actorId }, select: { role: true, status: true } });
  if (!actor || actor.status !== "ACTIVE" || (actor.role !== "OWNER" && actor.role !== "MODERATOR")) return { ok: false, reason: "NOT_STAFF" };
  const now = deps.now ? deps.now() : new Date();
  return deps.db.$transaction(async (tx) => {
    const row = await tx.feedback.findUnique({ where: { id: input.feedbackId } });
    if (!row) return { ok: false, reason: "NOT_FOUND" } as const;
    const notes = input.notes.trim().slice(0, 2000) || null;
    if (row.status === input.status && (notes ?? null) === row.staffNotes) return { ok: false, reason: "UNCHANGED" } as const;
    await tx.feedback.update({
      where: { id: row.id },
      data: { status: input.status, staffNotes: notes, handledById: input.actorId, handledAt: now },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "feedback.updated",
      subjectType: "Feedback",
      subjectId: row.id,
      before: { status: row.status },
      after: { status: input.status, notes },
      ipHash: ctx.ipHash,
    });
    return { ok: true } as const;
  });
}

export async function listFeedback(db: Db, status: FeedbackStatus | "ALL", take = 100) {
  return db.feedback.findMany({
    where: status === "ALL" ? {} : { status },
    orderBy: [{ createdAt: "desc" }],
    take,
    include: { user: { select: { id: true, displayName: true, email: true } }, handledBy: { select: { displayName: true } } },
  });
}
