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

export async function verifyAuditChain(db: Db): Promise<ChainVerification> {
  const events = await db.auditEvent.findMany({ orderBy: { seq: "asc" } });
  let prevHash = GENESIS_HASH;
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
    if (e.prevHash !== prevHash || e.hash !== expected) {
      return { ok: false, checked: events.length, firstBrokenSeq: e.seq };
    }
    prevHash = e.hash;
  }
  return { ok: true, checked: events.length, firstBrokenSeq: null };
}
