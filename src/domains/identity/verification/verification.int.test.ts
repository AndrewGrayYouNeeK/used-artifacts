import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createVerifiedUser, testDb } from "../../../../test/helpers";
import { FakeIdentityProvider } from "./fake-provider";
import type { VerifiedDocument } from "./provider";
import {
  MAX_VERIFICATION_ATTEMPTS,
  checkIdentityGate,
  processVerificationEvent,
  reviewIdentity,
  startVerification,
  type VerificationDeps,
} from "./verification";

const db = testDb();
afterAll(() => db.$disconnect());

function deps(provider = new FakeIdentityProvider("http://test.local")): VerificationDeps & {
  provider: FakeIdentityProvider;
} {
  return { db, provider, fingerprintSecret: "test-fingerprint-secret-000000000000000", appUrl: "http://test.local" };
}

function doc(overrides: Partial<VerifiedDocument> = {}): VerifiedDocument {
  return {
    firstName: "Jane",
    lastName: `Doe-${randomUUID().slice(0, 6)}`,
    dob: { year: 1980, month: 4, day: 12 },
    documentNumber: `D${randomUUID().slice(0, 10)}`,
    documentType: "driving_license",
    issuingCountry: "US",
    ...overrides,
  };
}

async function verifyWith(d: ReturnType<typeof deps>, userId: string, document: VerifiedDocument) {
  const started = await startVerification(d, { userId, consent: true });
  if (!started.ok) throw new Error(`start failed: ${started.reason}`);
  const record = await db.identityVerification.findUniqueOrThrow({ where: { userId } });
  d.provider.setDocument(record.providerSessionId, document);
  return processVerificationEvent(d, {
    eventId: `evt_${randomUUID()}`,
    kind: "VERIFIED",
    sessionId: record.providerSessionId,
  });
}

const auditActions = async (subjectId: string) =>
  (await db.auditEvent.findMany({ where: { subjectId }, orderBy: { seq: "asc" } })).map((e) => e.action);

describe("identity verification", () => {
  it("requires consent before starting a provider session", async () => {
    const user = await createVerifiedUser(db);
    expect(await startVerification(deps(), { userId: user.id, consent: false })).toEqual({
      ok: false,
      reason: "CONSENT_REQUIRED",
    });
    expect(await db.identityVerification.count({ where: { userId: user.id } })).toBe(0);
  });

  it("verifies, records only minimal PII, audits, and unlocks selling but not bidding", async () => {
    const d = deps();
    const user = await createVerifiedUser(db);
    expect(await checkIdentityGate(db, user.id, "SELL")).toEqual({ ok: false, reason: "NOT_VERIFIED" });

    const document = doc();
    const result = await verifyWith(d, user.id, document);
    expect(result).toEqual({ outcome: "UPDATED", status: "VERIFIED" });

    const record = await db.identityVerification.findUniqueOrThrow({ where: { userId: user.id } });
    expect(record.legalName).toBe(`Jane ${document.lastName}`);
    expect(record.dobYear).toBe(1980);
    expect(record.consentNoticeVersion).toBe(1);
    expect(JSON.stringify(record)).not.toContain(document.documentNumber);
    expect(await auditActions(record.id)).toEqual(["identity.verification_started", "identity.verified"]);

    expect(await checkIdentityGate(db, user.id, "SELL")).toEqual({ ok: true, legalName: record.legalName });
    expect(await checkIdentityGate(db, user.id, "BID")).toEqual({ ok: false, reason: "AUCTIONS_DISABLED" });
    expect((await checkIdentityGate(db, user.id, "BID", { auctionsEnabled: true })).ok).toBe(true);
    expect(await startVerification(d, { userId: user.id, consent: true })).toEqual({
      ok: false,
      reason: "ALREADY_VERIFIED",
    });
  });

  it("processes a retried webhook event only once", async () => {
    const d = deps();
    const user = await createVerifiedUser(db);
    await startVerification(d, { userId: user.id, consent: true });
    const record = await db.identityVerification.findUniqueOrThrow({ where: { userId: user.id } });
    const event = { eventId: `evt_${randomUUID()}`, kind: "REQUIRES_INPUT" as const, sessionId: record.providerSessionId, errorCode: "selfie_face_mismatch" };

    expect(await processVerificationEvent(d, event)).toEqual({ outcome: "UPDATED", status: "REQUIRES_INPUT" });
    expect(await processVerificationEvent(d, event)).toEqual({ outcome: "DUPLICATE_EVENT" });
    expect(await auditActions(record.id)).toEqual(["identity.verification_started", "identity.requires_input"]);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: record.id } })).lastErrorCode).toBe(
      "selfie_face_mismatch",
    );
  });

  it("rejects a document already bound to another account and links the two", async () => {
    const d = deps();
    const first = await createVerifiedUser(db);
    const second = await createVerifiedUser(db);
    const document = doc();
    await verifyWith(d, first.id, document);

    const result = await verifyWith(d, second.id, { ...document, documentNumber: document.documentNumber.toLowerCase() });
    expect(result).toEqual({ outcome: "UPDATED", status: "DUPLICATE_REJECTED" });

    const record = await db.identityVerification.findUniqueOrThrow({ where: { userId: second.id } });
    expect(record.conflictingUserId).toBe(first.id);
    expect(record.documentFingerprintHash).toBeNull();
    const [userAId, userBId] = [first.id, second.id].sort();
    expect(
      await db.accountLink.findUnique({
        where: { userAId_userBId_signal: { userAId, userBId, signal: "SAME_ID_HASH_ATTEMPT" } },
      }),
    ).not.toBeNull();
    expect(await db.fraudSignal.count({ where: { subjectId: second.id, detector: "DUPLICATE_IDENTITY" } })).toBe(1);
    expect(await auditActions(record.id)).toContain("identity.duplicate_rejected");

    expect(await checkIdentityGate(db, second.id, "SELL")).toEqual({ ok: false, reason: "BLOCKED" });
    expect(await startVerification(d, { userId: second.id, consent: true })).toEqual({ ok: false, reason: "BLOCKED" });
  });

  it("only one of two accounts racing with the same document is verified", async () => {
    const d = deps();
    const [a, b] = [await createVerifiedUser(db), await createVerifiedUser(db)];
    const document = doc();
    const events = [];
    for (const user of [a, b]) {
      await startVerification(d, { userId: user.id, consent: true });
      const record = await db.identityVerification.findUniqueOrThrow({ where: { userId: user.id } });
      d.provider.setDocument(record.providerSessionId, document);
      events.push({ eventId: `evt_${randomUUID()}`, kind: "VERIFIED" as const, sessionId: record.providerSessionId });
    }
    const results = await Promise.all(events.map((e) => processVerificationEvent(d, e)));
    const statuses = results.map((r) => (r.outcome === "UPDATED" ? r.status : r.outcome)).sort();
    expect(statuses).toEqual(["DUPLICATE_REJECTED", "VERIFIED"]);
  });

  it("the database itself refuses a second account with the same document fingerprint", async () => {
    const [a, b] = [await createVerifiedUser(db), await createVerifiedUser(db)];
    const hash = randomUUID();
    const base = { provider: "fake", status: "VERIFIED" as const, documentFingerprintHash: hash };
    await db.identityVerification.create({ data: { ...base, userId: a.id, providerSessionId: randomUUID() } });
    await expect(
      db.identityVerification.create({ data: { ...base, userId: b.id, providerSessionId: randomUUID() } }),
    ).rejects.toThrow();
  });

  it("holds same name and birth date with a different document for staff review", async () => {
    const d = deps();
    const first = await createVerifiedUser(db);
    const second = await createVerifiedUser(db);
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const document = doc();
    await verifyWith(d, first.id, document);

    const result = await verifyWith(d, second.id, {
      ...document,
      firstName: "JANE",
      documentNumber: "P-998877",
      documentType: "passport",
    });
    expect(result).toEqual({ outcome: "UPDATED", status: "NEEDS_REVIEW" });
    expect(await checkIdentityGate(db, second.id, "SELL")).toEqual({ ok: false, reason: "UNDER_REVIEW" });

    const record = await db.identityVerification.findUniqueOrThrow({ where: { userId: second.id } });
    expect(record.conflictingUserId).toBe(first.id);

    const review = { verificationId: record.id, decision: "APPROVE" as const, notes: "Twin siblings; confirmed by phone" };
    expect(await reviewIdentity(d, { ...review, reviewerId: second.id })).toEqual({ ok: false, reason: "SELF_REVIEW" });
    expect(await reviewIdentity(d, { ...review, reviewerId: owner.id, notes: "" })).toEqual({
      ok: false,
      reason: "NOTES_REQUIRED",
    });
    expect(await reviewIdentity(d, { ...review, reviewerId: owner.id })).toEqual({ ok: true, status: "VERIFIED" });
    expect((await checkIdentityGate(db, second.id, "SELL")).ok).toBe(true);
    expect(await auditActions(record.id)).toEqual([
      "identity.verification_started",
      "identity.needs_review",
      "identity.review_approved",
    ]);
  });

  it("caps paid verification attempts", async () => {
    const d = deps();
    const user = await createVerifiedUser(db);
    for (let i = 0; i < MAX_VERIFICATION_ATTEMPTS; i++) {
      expect((await startVerification(d, { userId: user.id, consent: true })).ok).toBe(true);
    }
    expect(await startVerification(d, { userId: user.id, consent: true })).toEqual({
      ok: false,
      reason: "TOO_MANY_ATTEMPTS",
    });
  });

  it("ignores events for unknown sessions but audits them", async () => {
    const sessionId = `fake_vs_${randomUUID()}`;
    expect(
      await processVerificationEvent(deps(), { eventId: `evt_${randomUUID()}`, kind: "VERIFIED", sessionId }),
    ).toEqual({ outcome: "UNKNOWN_SESSION" });
    const audit = await db.auditEvent.findFirst({ where: { action: "identity.webhook_unknown_session" }, orderBy: { seq: "desc" } });
    expect(audit?.after).toMatchObject({ sessionId });
  });
});
