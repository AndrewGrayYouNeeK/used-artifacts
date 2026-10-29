import { afterAll, describe, expect, it } from "vitest";
import { createLiveListing, createVerifiedUser, testDb } from "../../../test/helpers";
import { platform } from "@/config/platform";
import { MemoryMailer } from "@/lib/email/mailer";
import {
  assignAuthentication,
  authenticatedListingIds,
  createAuthenticator,
  listingAuthentication,
  recordAuthenticationResult,
  requestAuthentication,
  revokeAuthentication,
  updateAuthenticator,
  type GradingDeps,
} from "./authentication";

const db = testDb();
afterAll(() => db.$disconnect());

function makeDeps(): GradingDeps & { mailer: MemoryMailer } {
  return { db, mailer: new MemoryMailer(), appUrl: "http://test.local", platform: { ...platform, highValueThresholdCents: 50_000 } };
}

async function partner(ownerId: string, opts: { specialtyCategoryIds?: string[]; agreementSigned?: boolean } = {}) {
  const created = await createAuthenticator(
    { db },
    {
      actorId: ownerId,
      name: "Dana Flint",
      organization: "Ohio Valley Lithic Authentication",
      credentials: "30 years authenticating Eastern Woodlands lithics",
      specialtyCategoryIds: opts.specialtyCategoryIds ?? [],
      agreementSigned: opts.agreementSigned ?? true,
    },
  );
  if (!created.ok) throw new Error(created.reason);
  return created.authenticatorId;
}

describe("partner authentication (Grading Stage 1)", () => {
  it("only lets the owner add partners", async () => {
    const mod = await createVerifiedUser(db, { role: "MODERATOR" });
    expect(
      await createAuthenticator({ db }, { actorId: mod.id, name: "X Y", credentials: "Some credentials", specialtyCategoryIds: [], agreementSigned: true }),
    ).toEqual({ ok: false, reason: "OWNER_ONLY" });
  });

  it("takes a seller request on a high-value listing through assignment to a published badge", async () => {
    const deps = makeDeps();
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const { seller, listingId, categoryId } = await createLiveListing(db, { askingPrice: 75_000 });
    const cheap = await createLiveListing(db, { askingPrice: 10_000, seller });

    expect(await requestAuthentication(deps, { sellerUserId: seller.id, listingId: cheap.listingId })).toEqual({ ok: false, reason: "BELOW_THRESHOLD" });
    const other = await createVerifiedUser(db);
    expect(await requestAuthentication(deps, { sellerUserId: other.id, listingId })).toEqual({ ok: false, reason: "NOT_FOUND" });

    const requested = await requestAuthentication(deps, { sellerUserId: seller.id, listingId, notes: "Found in 1960s Boone County collection" });
    if (!requested.ok) throw new Error(requested.reason);
    expect(await requestAuthentication(deps, { sellerUserId: seller.id, listingId })).toEqual({ ok: false, reason: "ALREADY_REQUESTED" });

    const unsigned = await partner(owner.id, { agreementSigned: false });
    expect(await assignAuthentication(deps, { actorId: owner.id, authenticatorId: unsigned, submissionId: requested.submissionId })).toEqual({
      ok: false,
      reason: "NO_AGREEMENT",
    });
    const otherCategory = (await createLiveListing(db)).categoryId;
    const specialist = await partner(owner.id, { specialtyCategoryIds: [otherCategory] });
    expect(await assignAuthentication(deps, { actorId: owner.id, authenticatorId: specialist, submissionId: requested.submissionId })).toEqual({
      ok: false,
      reason: "OUTSIDE_SPECIALTY",
    });

    const authenticator = await partner(owner.id, { specialtyCategoryIds: [categoryId] });
    expect(await assignAuthentication(deps, { actorId: owner.id, authenticatorId: authenticator, submissionId: requested.submissionId })).toEqual({
      ok: true,
      submissionId: requested.submissionId,
    });
    const sellerEmail = (await db.user.findUniqueOrThrow({ where: { id: seller.id } })).email;
    expect(deps.mailer.sent.at(-1)).toMatchObject({ to: sellerEmail, subject: "Your listing is with a partner authenticator" });
    expect(await listingAuthentication(db, listingId)).toBeNull();

    const mod = await createVerifiedUser(db, { role: "MODERATOR" });
    expect(
      await recordAuthenticationResult(deps, { actorId: mod.id, submissionId: requested.submissionId, outcome: "AUTHENTICATED", notes: "Consistent with type." }),
    ).toEqual({ ok: false, reason: "OWNER_ONLY" });
    const recorded = await recordAuthenticationResult(deps, {
      actorId: owner.id,
      submissionId: requested.submissionId,
      outcome: "AUTHENTICATED",
      notes: "Patination and flaking consistent with an authentic Adena point.",
    });
    if (!recorded.ok) throw new Error(recorded.reason);
    expect(recorded.certificateNumber).toMatch(/^UA-A-[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const badge = await listingAuthentication(db, listingId);
    expect(badge).toMatchObject({ certificateNumber: recorded.certificateNumber, partner: "Ohio Valley Lithic Authentication" });
    expect(await authenticatedListingIds(db, [listingId, cheap.listingId])).toEqual(new Set([listingId]));
    expect(await requestAuthentication(deps, { sellerUserId: seller.id, listingId })).toEqual({ ok: false, reason: "ALREADY_AUTHENTICATED" });

    const result = await db.gradingResult.findUniqueOrThrow({ where: { certificateNumber: recorded.certificateNumber! } });
    await expect(db.gradingResult.update({ where: { id: result.id }, data: { tierAwarded: "GRADED" } })).rejects.toThrow(/no longer editable/);
    await expect(db.gradingResult.delete({ where: { id: result.id } })).rejects.toThrow(/cannot be deleted/);

    expect(await revokeAuthentication(deps, { actorId: owner.id, resultId: result.id, reason: "no" })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    expect(await revokeAuthentication(deps, { actorId: owner.id, resultId: result.id, reason: "Partner retracted after seeing the base." })).toEqual({ ok: true });
    expect(await listingAuthentication(db, listingId)).toBeNull();
    expect(deps.mailer.sent.at(-1)).toMatchObject({ subject: "An authentication badge was removed" });
    expect(await revokeAuthentication(deps, { actorId: owner.id, resultId: result.id, reason: "Again for the test." })).toEqual({ ok: false, reason: "NOT_PUBLISHED" });
  });

  it("lets the owner start one directly, and records a failed authentication without a badge", async () => {
    const deps = makeDeps();
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const authenticator = await partner(owner.id);
    const { listingId } = await createLiveListing(db, { askingPrice: 120_000 });
    const started = await assignAuthentication(deps, { actorId: owner.id, authenticatorId: authenticator, listingId });
    if (!started.ok) throw new Error(started.reason);
    expect(await assignAuthentication(deps, { actorId: owner.id, authenticatorId: authenticator, listingId })).toEqual({
      ok: false,
      reason: "ALREADY_REQUESTED",
    });

    const recorded = await recordAuthenticationResult(deps, {
      actorId: owner.id,
      submissionId: started.submissionId,
      outcome: "NOT_AUTHENTICATED",
      notes: "Modern knapping: fresh flake scars under the patina.",
    });
    expect(recorded).toEqual({ ok: true, certificateNumber: null });
    expect(await listingAuthentication(db, listingId)).toBeNull();
    expect((await db.gradingSubmission.findUniqueOrThrow({ where: { id: started.submissionId } })).status).toBe("REJECTED");
    expect(deps.mailer.sent.at(-1)).toMatchObject({ subject: "Partner authentication result" });
    expect(deps.mailer.sent.at(-1)!.text).toContain("fresh flake scars");

    const again = await assignAuthentication(deps, { actorId: owner.id, authenticatorId: authenticator, listingId });
    if (!again.ok) throw new Error(again.reason);
    expect(await recordAuthenticationResult(deps, { actorId: owner.id, submissionId: again.submissionId, outcome: "INCONCLUSIVE", notes: "Need photos of the base." })).toEqual({
      ok: true,
      certificateNumber: null,
    });
    expect((await db.gradingSubmission.findUniqueOrThrow({ where: { id: again.submissionId } })).status).toBe("RETURNED");
  });

  it("stops assigning to a paused partner", async () => {
    const deps = makeDeps();
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const authenticator = await partner(owner.id);
    expect(await updateAuthenticator({ db }, { actorId: owner.id, authenticatorId: authenticator, status: "PAUSED" })).toEqual({ ok: true });
    const { listingId } = await createLiveListing(db, { askingPrice: 90_000 });
    expect(await assignAuthentication(deps, { actorId: owner.id, authenticatorId: authenticator, listingId })).toEqual({
      ok: false,
      reason: "AUTHENTICATOR_UNAVAILABLE",
    });
  });

  it("refuses in-house grades without partner verification, and MUSEUM_GRADE, at the database", async () => {
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const { listingId, seller, categoryId } = await createLiveListing(db, { askingPrice: 60_000 });
    const submission = await db.gradingSubmission.create({
      data: { listingId, ownerUserId: seller.id, categoryId, requestedTier: "AUTHENTICATED", feeCents: 0, status: "IN_REVIEW" },
    });
    await expect(
      db.gradingResult.create({
        data: { submissionId: submission.id, tierAwarded: "AUTHENTICATED", certificateNumber: `T-${submission.id}`, gradedByUserId: owner.id, status: "PUBLISHED", publishedAt: new Date() },
      }),
    ).rejects.toThrow(/partner verification/);
    await expect(
      db.gradingResult.create({
        data: { submissionId: submission.id, tierAwarded: "MUSEUM_GRADE", certificateNumber: `M-${submission.id}`, gradedByUserId: owner.id, status: "PUBLISHED", publishedAt: new Date() },
      }),
    ).rejects.toThrow(/MUSEUM_GRADE/);
    await expect(
      db.gradingResult.create({ data: { submissionId: submission.id, tierAwarded: "AUTHENTICATED", certificateNumber: `N-${submission.id}`, status: "DRAFT" } }),
    ).rejects.toThrow(/grading_result_one_grader/);
  });
});
