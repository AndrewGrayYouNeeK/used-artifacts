import type { Db } from "@/lib/db";
import type { IdentityVerificationStatus } from "@/generated/prisma/enums";
import { hmacHex } from "@/lib/crypto";
import { platform, type PlatformConfig } from "@/config/platform";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";
import { normalizeLegalName } from "@/domains/identity/legal-name";
import type { RequestContext } from "@/domains/identity/accounts";
import type { IdentityProvider, VerificationEvent, VerifiedDocument } from "./provider";

export const MAX_VERIFICATION_ATTEMPTS = 5;

/** Bump when the consent wording on the verify page changes (BIPA, BUILD_PLAN L11). */
export const VERIFICATION_CONSENT_VERSION = 1;

export interface VerificationDeps {
  db: Db;
  provider: IdentityProvider;
  fingerprintSecret: string;
  appUrl: string;
  now?: () => Date;
}

const clock = (deps: { now?: () => Date }) => (deps.now ? deps.now() : new Date());

const isoDob = (dob: VerifiedDocument["dob"]) =>
  `${dob.year}-${String(dob.month).padStart(2, "0")}-${String(dob.day).padStart(2, "0")}`;

export function documentFingerprint(secret: string, doc: VerifiedDocument): string {
  const number = doc.documentNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return hmacHex(secret, `doc:v1|${doc.issuingCountry.toUpperCase()}|${number}|${isoDob(doc.dob)}`);
}

export function personFingerprint(secret: string, doc: VerifiedDocument): string {
  const name = normalizeLegalName(`${doc.firstName} ${doc.lastName}`);
  return hmacHex(secret, `person:v1|${name}|${isoDob(doc.dob)}`);
}

export type StartVerificationResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: "CONSENT_REQUIRED" | "ALREADY_VERIFIED" | "UNDER_REVIEW" | "BLOCKED" | "TOO_MANY_ATTEMPTS";
    };

export async function startVerification(
  deps: VerificationDeps,
  input: { userId: string; consent: boolean },
  ctx: RequestContext = {},
): Promise<StartVerificationResult> {
  if (!input.consent) return { ok: false, reason: "CONSENT_REQUIRED" };

  const existing = await deps.db.identityVerification.findUnique({ where: { userId: input.userId } });
  if (existing) {
    switch (existing.status) {
      case "VERIFIED":
        return { ok: false, reason: "ALREADY_VERIFIED" };
      case "NEEDS_REVIEW":
        return { ok: false, reason: "UNDER_REVIEW" };
      case "DUPLICATE_REJECTED":
      case "REJECTED":
        return { ok: false, reason: "BLOCKED" };
      case "PENDING":
      case "PROCESSING":
      case "REQUIRES_INPUT":
      case "CANCELED":
        break;
      default: {
        const exhaustive: never = existing.status;
        throw new Error(`Unknown verification status: ${String(exhaustive)}`);
      }
    }
    if (existing.attemptCount >= MAX_VERIFICATION_ATTEMPTS) {
      return { ok: false, reason: "TOO_MANY_ATTEMPTS" };
    }
  }

  const session = await deps.provider.createSession({
    userId: input.userId,
    returnUrl: `${deps.appUrl}/account/verify/return`,
  });
  const now = clock(deps);
  await deps.db.$transaction(async (tx) => {
    const record = await tx.identityVerification.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        provider: deps.provider.name,
        providerSessionId: session.sessionId,
        status: "PENDING",
        attemptCount: 1,
        consentedAt: now,
        consentNoticeVersion: VERIFICATION_CONSENT_VERSION,
      },
      update: {
        provider: deps.provider.name,
        providerSessionId: session.sessionId,
        status: "PENDING",
        attemptCount: { increment: 1 },
        lastErrorCode: null,
        consentedAt: now,
        consentNoticeVersion: VERIFICATION_CONSENT_VERSION,
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.userId,
      actorType: "USER",
      action: "identity.verification_started",
      subjectType: "IdentityVerification",
      subjectId: record.id,
      after: {
        provider: deps.provider.name,
        attempt: record.attemptCount,
        consentNoticeVersion: VERIFICATION_CONSENT_VERSION,
      },
      ipHash: ctx.ipHash,
    });
  });
  return { ok: true, url: session.url };
}

export type ProcessEventResult =
  | { outcome: "DUPLICATE_EVENT" | "UNKNOWN_SESSION" | "STALE" }
  | { outcome: "UPDATED"; status: IdentityVerificationStatus };

/**
 * Applies one provider event. Safe to call more than once per event (webhook
 * retries) and serialized per document, so two accounts racing with the same
 * ID can't both end up verified.
 */
export async function processVerificationEvent(
  deps: VerificationDeps,
  event: VerificationEvent,
): Promise<ProcessEventResult> {
  const seen = await deps.db.webhookEvent.findUnique({ where: { id: event.eventId } });
  if (seen) return { outcome: "DUPLICATE_EVENT" };

  const doc = event.kind === "VERIFIED" ? await deps.provider.fetchVerifiedDocument(event.sessionId) : null;

  return deps.db.$transaction(async (tx) => {
    const inserted = await tx.webhookEvent.createMany({
      data: [{ id: event.eventId, provider: deps.provider.name, type: event.kind, processedAt: clock(deps) }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return { outcome: "DUPLICATE_EVENT" } as const;

    const record = await tx.identityVerification.findUnique({
      where: { providerSessionId: event.sessionId },
    });
    if (!record) {
      await writeAuditEvent(tx, {
        actorType: "WEBHOOK",
        action: "identity.webhook_unknown_session",
        subjectType: "IdentityVerification",
        after: { provider: deps.provider.name, sessionId: event.sessionId, kind: event.kind },
      });
      return { outcome: "UNKNOWN_SESSION" } as const;
    }
    if (!["PENDING", "PROCESSING", "REQUIRES_INPUT"].includes(record.status)) {
      return { outcome: "STALE" } as const;
    }

    const status = await applyEvent(tx, deps, record, event, doc);
    return { outcome: "UPDATED", status } as const;
  });
}

interface VerificationRow {
  id: string;
  userId: string;
}

async function applyEvent(
  tx: Tx,
  deps: VerificationDeps,
  record: VerificationRow,
  event: VerificationEvent,
  doc: VerifiedDocument | null,
): Promise<IdentityVerificationStatus> {
  const base = { actorType: "WEBHOOK" as const, subjectType: "IdentityVerification", subjectId: record.id };
  switch (event.kind) {
    case "PROCESSING":
      await tx.identityVerification.update({ where: { id: record.id }, data: { status: "PROCESSING" } });
      await writeAuditEvent(tx, { ...base, action: "identity.processing" });
      return "PROCESSING";
    case "REQUIRES_INPUT":
      await tx.identityVerification.update({
        where: { id: record.id },
        data: { status: "REQUIRES_INPUT", lastErrorCode: event.errorCode ?? null },
      });
      await writeAuditEvent(tx, {
        ...base,
        action: "identity.requires_input",
        after: { errorCode: event.errorCode ?? null },
      });
      return "REQUIRES_INPUT";
    case "CANCELED":
      await tx.identityVerification.update({ where: { id: record.id }, data: { status: "CANCELED" } });
      await writeAuditEvent(tx, { ...base, action: "identity.canceled" });
      return "CANCELED";
    case "VERIFIED":
      return applyVerified(tx, deps, record, doc);
    default: {
      const exhaustive: never = event.kind;
      throw new Error(`Unknown verification event: ${String(exhaustive)}`);
    }
  }
}

async function applyVerified(
  tx: Tx,
  deps: VerificationDeps,
  record: VerificationRow,
  doc: VerifiedDocument | null,
): Promise<IdentityVerificationStatus> {
  const base = { actorType: "WEBHOOK" as const, subjectType: "IdentityVerification", subjectId: record.id };
  if (!doc) {
    await tx.identityVerification.update({
      where: { id: record.id },
      data: { status: "REQUIRES_INPUT", lastErrorCode: "document_details_unavailable" },
    });
    await writeAuditEvent(tx, { ...base, action: "identity.document_details_unavailable" });
    return "REQUIRES_INPUT";
  }

  const docHash = documentFingerprint(deps.fingerprintSecret, doc);
  const personHash = personFingerprint(deps.fingerprintSecret, doc);
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${docHash}))`;
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${personHash}))`;

  const docHolder = await tx.identityVerification.findUnique({
    where: { documentFingerprintHash: docHash },
    select: { userId: true },
  });
  if (docHolder && docHolder.userId !== record.userId) {
    await tx.identityVerification.update({
      where: { id: record.id },
      data: { status: "DUPLICATE_REJECTED", conflictingUserId: docHolder.userId },
    });
    await recordLink(tx, record.userId, docHolder.userId, "SAME_ID_HASH_ATTEMPT", 100, {
      score: 100,
      verificationId: record.id,
    });
    await writeAuditEvent(tx, {
      ...base,
      action: "identity.duplicate_rejected",
      after: { conflictingUserId: docHolder.userId },
    });
    return "DUPLICATE_REJECTED";
  }

  const personMatch = await tx.identityVerification.findFirst({
    where: {
      personFingerprintHash: personHash,
      userId: { not: record.userId },
      status: { in: ["VERIFIED", "NEEDS_REVIEW", "REJECTED"] },
    },
    select: { userId: true },
  });

  const status: IdentityVerificationStatus = personMatch ? "NEEDS_REVIEW" : "VERIFIED";
  await tx.identityVerification.update({
    where: { id: record.id },
    data: {
      status,
      verifiedAt: status === "VERIFIED" ? clock(deps) : null,
      legalName: `${doc.firstName} ${doc.lastName}`.replace(/\s+/g, " ").trim(),
      dobYear: doc.dob.year,
      documentType: doc.documentType,
      issuingCountry: doc.issuingCountry.toUpperCase(),
      documentFingerprintHash: docHash,
      personFingerprintHash: personHash,
      conflictingUserId: personMatch?.userId ?? null,
      lastErrorCode: null,
    },
  });

  if (personMatch) {
    await recordLink(tx, record.userId, personMatch.userId, "SAME_PERSON_DETAILS", 80, {
      score: 70,
      verificationId: record.id,
    });
    await writeAuditEvent(tx, {
      ...base,
      action: "identity.needs_review",
      after: { conflictingUserId: personMatch.userId, reason: "same name and date of birth, different document" },
    });
  } else {
    await writeAuditEvent(tx, {
      ...base,
      action: "identity.verified",
      after: { documentType: doc.documentType, issuingCountry: doc.issuingCountry.toUpperCase() },
    });
  }
  return status;
}

async function recordLink(
  tx: Tx,
  userId: string,
  otherUserId: string,
  signal: "SAME_ID_HASH_ATTEMPT" | "SAME_PERSON_DETAILS",
  strength: number,
  signalInfo: { score: number; verificationId: string },
) {
  const [userAId, userBId] = [userId, otherUserId].sort();
  await tx.accountLink.upsert({
    where: { userAId_userBId_signal: { userAId, userBId, signal } },
    create: { userAId, userBId, signal, strength },
    update: {},
  });
  const fraud = await tx.fraudSignal.create({
    data: {
      subjectType: "User",
      subjectId: userId,
      detector: "DUPLICATE_IDENTITY",
      score: signalInfo.score,
      evidence: { signal, otherUserId, verificationId: signalInfo.verificationId },
    },
  });
  await writeAuditEvent(tx, {
    actorType: "SYSTEM",
    action: "fraud.signal_created",
    subjectType: "FraudSignal",
    subjectId: fraud.id,
    after: { detector: "DUPLICATE_IDENTITY", signal, userId, otherUserId },
  });
}

export type ReviewIdentityResult =
  | { ok: true; status: "VERIFIED" | "REJECTED" }
  | { ok: false; reason: "NOT_FOUND" | "NOT_IN_REVIEW" | "SELF_REVIEW" | "NOTES_REQUIRED" };

/** Staff decision on a NEEDS_REVIEW verification. */
export async function reviewIdentity(
  deps: Pick<VerificationDeps, "db" | "now">,
  input: { reviewerId: string; verificationId: string; decision: "APPROVE" | "REJECT"; notes: string },
  ctx: RequestContext = {},
): Promise<ReviewIdentityResult> {
  const notes = input.notes.trim();
  if (notes.length < 5) return { ok: false, reason: "NOTES_REQUIRED" };
  return deps.db.$transaction(async (tx) => {
    const record = await tx.identityVerification.findUnique({ where: { id: input.verificationId } });
    if (!record) return { ok: false, reason: "NOT_FOUND" } as const;
    if (record.userId === input.reviewerId) return { ok: false, reason: "SELF_REVIEW" } as const;
    if (record.status !== "NEEDS_REVIEW") return { ok: false, reason: "NOT_IN_REVIEW" } as const;
    const status = input.decision === "APPROVE" ? "VERIFIED" : "REJECTED";
    const now = clock(deps);
    await tx.identityVerification.update({
      where: { id: record.id },
      data: {
        status,
        verifiedAt: status === "VERIFIED" ? now : null,
        reviewedById: input.reviewerId,
        reviewedAt: now,
        reviewNotes: notes,
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.reviewerId,
      actorType: "ADMIN",
      action: status === "VERIFIED" ? "identity.review_approved" : "identity.review_rejected",
      subjectType: "IdentityVerification",
      subjectId: record.id,
      before: { status: record.status },
      after: { status, notes },
      ipHash: ctx.ipHash,
    });
    return { ok: true, status } as const;
  });
}

export type VerificationPurpose = "SELL" | "BID";

export type IdentityGate =
  | { ok: true; legalName: string }
  | { ok: false; reason: "AUCTIONS_DISABLED" | "NOT_VERIFIED" | "UNDER_REVIEW" | "BLOCKED" };

/**
 * Selling and bidding need a verified identity; browsing and fixed-price
 * buying don't (owner decision B4).
 */
export async function checkIdentityGate(
  db: Pick<Db, "identityVerification">,
  userId: string,
  purpose: VerificationPurpose,
  config: Pick<PlatformConfig, "auctionsEnabled"> = platform,
): Promise<IdentityGate> {
  if (purpose === "BID" && !config.auctionsEnabled) return { ok: false, reason: "AUCTIONS_DISABLED" };
  const record = await db.identityVerification.findUnique({
    where: { userId },
    select: { status: true, legalName: true },
  });
  const status = record?.status;
  switch (status) {
    case "VERIFIED":
      if (!record?.legalName) return { ok: false, reason: "NOT_VERIFIED" };
      return { ok: true, legalName: record.legalName };
    case "NEEDS_REVIEW":
      return { ok: false, reason: "UNDER_REVIEW" };
    case "DUPLICATE_REJECTED":
    case "REJECTED":
      return { ok: false, reason: "BLOCKED" };
    case undefined:
    case "PENDING":
    case "PROCESSING":
    case "REQUIRES_INPUT":
    case "CANCELED":
      return { ok: false, reason: "NOT_VERIFIED" };
    default: {
      const exhaustive: never = status;
      throw new Error(`Unknown verification status: ${String(exhaustive)}`);
    }
  }
}
