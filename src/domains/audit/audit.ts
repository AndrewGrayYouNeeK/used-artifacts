import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { AuditActorType } from "@/generated/prisma/enums";
import { canonicalJson, sha256Hex } from "@/lib/crypto";

export type Tx = Prisma.TransactionClient;

export const GENESIS_HASH = "0".repeat(64);

// Arbitrary constant; serializes appends so the hash chain has no forks.
const AUDIT_CHAIN_LOCK_KEY = 7_202_610;

export interface AuditInput {
  actorUserId?: string | null;
  actorType: AuditActorType;
  action: string;
  subjectType: string;
  subjectId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  ipHash?: string | null;
  requestId?: string | null;
}

interface HashedFields {
  id: string;
  at: string;
  actorUserId: string | null;
  actorType: AuditActorType;
  action: string;
  subjectType: string;
  subjectId: string | null;
  before: unknown;
  after: unknown;
  ipHash: string | null;
  requestId: string | null;
}

export function computeAuditHash(prevHash: string, fields: HashedFields): string {
  return sha256Hex(prevHash + canonicalJson(fields));
}

/** Must run inside a transaction: takes a transaction-scoped advisory lock. */
export async function writeAuditEvent(tx: Tx, input: AuditInput) {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY}::bigint)`;

  const last = await tx.auditEvent.findFirst({
    orderBy: { seq: "desc" },
    select: { hash: true },
  });
  const prevHash = last?.hash ?? GENESIS_HASH;

  const fields: HashedFields = {
    id: randomUUID(),
    at: new Date().toISOString(),
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    ipHash: input.ipHash ?? null,
    requestId: input.requestId ?? null,
  };

  return tx.auditEvent.create({
    data: {
      ...fields,
      at: new Date(fields.at),
      before: input.before ?? undefined,
      after: input.after ?? undefined,
      prevHash,
      hash: computeAuditHash(prevHash, fields),
    },
  });
}

export function audit(db: Db, input: AuditInput) {
  return db.$transaction((tx) => writeAuditEvent(tx, input));
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBrokenSeq: bigint | null;
}

const VERIFY_BATCH = 2000;

/** Recomputes every hash in order, in batches, so the check scales with the log. */
export async function verifyAuditChain(db: Db): Promise<ChainVerification> {
  let prevHash = GENESIS_HASH;
  let checked = 0;
  let afterSeq: bigint | null = null;
  for (;;) {
    const events: Awaited<ReturnType<typeof db.auditEvent.findMany>> = await db.auditEvent.findMany({
      where: afterSeq === null ? {} : { seq: { gt: afterSeq } },
      orderBy: { seq: "asc" },
      take: VERIFY_BATCH,
    });
    for (const e of events) {
      const expected = computeAuditHash(prevHash, {
        id: e.id,
        at: e.at.toISOString(),
        actorUserId: e.actorUserId,
        actorType: e.actorType,
        action: e.action,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        before: e.before ?? null,
        after: e.after ?? null,
        ipHash: e.ipHash,
        requestId: e.requestId,
      });
      checked++;
      if (e.prevHash !== prevHash || e.hash !== expected) return { ok: false, checked, firstBrokenSeq: e.seq };
      prevHash = e.hash;
    }
    if (events.length < VERIFY_BATCH) return { ok: true, checked, firstBrokenSeq: null };
    afterSeq = events[events.length - 1].seq;
  }
}

export interface AuditQuery {
  action?: string;
  subjectType?: string;
  subjectId?: string;
  actorUserId?: string;
  /** Page backwards from this sequence number. */
  beforeSeq?: bigint;
  limit?: number;
}

/** Read-only search for the GM audit-log viewer, newest first. */
export async function searchAuditEvents(db: Db, query: AuditQuery) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const events = await db.auditEvent.findMany({
    where: {
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.beforeSeq !== undefined ? { seq: { lt: query.beforeSeq } } : {}),
    },
    orderBy: { seq: "desc" },
    take: limit + 1,
    include: { actor: { select: { displayName: true, email: true } } },
  });
  const page = events.slice(0, limit);
  return { events: page, nextBeforeSeq: events.length > limit ? page[page.length - 1].seq : null };
}
