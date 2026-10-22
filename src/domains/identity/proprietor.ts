import type { Db } from "@/lib/db";
import { writeAuditEvent } from "@/domains/audit/audit";

export class ProprietorAlreadyAssignedError extends Error {
  constructor() {
    super("The Proprietor badge is already assigned and can never be reassigned.");
  }
}

/**
 * One-time bootstrap, run only from `npm run proprietor:assign`. Promotes the
 * account to OWNER and creates the singleton Proprietor row in one transaction.
 * There is intentionally no API route or server action that calls this.
 */
export async function assignProprietor(db: Db, email: string) {
  const normalized = email.trim().toLowerCase();
  return db.$transaction(async (tx) => {
    if (await tx.proprietor.findUnique({ where: { id: 1 } })) {
      throw new ProprietorAlreadyAssignedError();
    }
    const user = await tx.user.findUnique({ where: { email: normalized } });
    if (!user) {
      throw new Error(`No account with email ${normalized}. Sign up first.`);
    }
    if (!user.emailVerifiedAt) {
      throw new Error(`${normalized} has not verified their email yet.`);
    }
    if (user.role !== "OWNER") {
      await tx.user.update({ where: { id: user.id }, data: { role: "OWNER" } });
    }
    const proprietor = await tx.proprietor.create({ data: { userId: user.id } });
    await writeAuditEvent(tx, {
      actorUserId: null,
      actorType: "SYSTEM",
      action: "proprietor.assigned",
      subjectType: "User",
      subjectId: user.id,
      before: { role: user.role },
      after: { role: "OWNER", proprietor: true },
    });
    return proprietor;
  });
}

export async function getProprietorUserId(db: Db): Promise<string | null> {
  const row = await db.proprietor.findUnique({ where: { id: 1 }, select: { userId: true } });
  return row?.userId ?? null;
}
