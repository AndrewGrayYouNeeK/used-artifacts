import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCategory,
  createVerifiedUser,
  ensureProvenanceTemplate,
  markIdentityVerified,
  testDb,
  testPhotos,
} from "../../../test/helpers";
import { PROVENANCE_TEMPLATE_V2 } from "@/domains/compliance/provenance-template";
import { decideListingReview } from "@/domains/compliance/review";
import { createStorefront, submitListing } from "@/domains/listings/listings";
import type { ListingSubmission } from "@/domains/listings/rules";
import { recordListingOutcome } from "@/domains/listings/outcomes";
import { FakeVisionProvider } from "./fake-vision";
import { suggestFromPhotos } from "./analyzer";

const db = testDb();
beforeAll(() => ensureProvenanceTemplate(db));
afterAll(() => db.$disconnect());

let counter = 0;
async function seller() {
  const user = await createVerifiedUser(db);
  await markIdentityVerified(db, user.id, "Jane Q Seller");
  const store = await createStorefront({ db }, { userId: user.id, name: "AI Test Store", slug: `ai-store-${Date.now()}-${counter++}` });
  if (!store.ok) throw new Error(store.reason);
  return user;
}

function submission(categoryId: string, overrides: Partial<ListingSubmission> = {}): ListingSubmission {
  return {
    categoryId,
    title: "Stemmed point",
    description: "Chert stemmed point, about 2 inches, tip intact.",
    askingPrice: 9_000,
    shipping: 0,
    acquisitionSource: "PURCHASED",
    acquisitionDetails: "Bought at a Kentucky collectors' show in 2001.",
    attestationKeys: PROVENANCE_TEMPLATE_V2.attestations.map((a) => a.key),
    iacaAcknowledged: false,
    signedName: "Jane Q Seller",
    ...overrides,
  };
}

const photosFor = (photos: ReturnType<typeof testPhotos>) => photos.map((p) => ({ bytes: p.bytes, pHash: p.pHash }));

describe("photo analyzer", () => {
  it("analyzes every submission and attaches the record to the listing", async () => {
    const vision = new FakeVisionProvider();
    const user = await seller();
    const category = await createCategory(db);
    const result = await submitListing({ db, vision }, { userId: user.id, submission: submission(category.id), photos: testPhotos(2) });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(vision.requests).toHaveLength(1);
    expect(vision.requests[0].images).toHaveLength(2);

    const analysis = await db.aiAnalysis.findFirstOrThrow({ where: { listingId: result.listingId } });
    expect(analysis).toMatchObject({ provider: "fake", promptVersion: "photo-analyzer-v1", requestedByUserId: user.id });
    expect(analysis.photoIds).toHaveLength(2);
    expect(analysis.sellerDecisions).toEqual({ previewed: false, accepted: [], rejected: [] });
    const review = await db.complianceReview.findUniqueOrThrow({ where: { id: result.reviewId } });
    expect(review.flags).toMatchObject({ ai: { analysisId: analysis.id, blocksPublishing: false } });
    expect(await db.auditEvent.findFirst({ where: { subjectId: analysis.id, action: "ai.analysis_recorded" } })).not.toBeNull();
  });

  it("reuses the seller's suggestion run for the same photos and records accepted and rejected suggestions", async () => {
    const vision = new FakeVisionProvider();
    const user = await seller();
    const category = await createCategory(db);
    const photos = testPhotos(1);
    const suggested = await suggestFromPhotos({ db, vision }, { userId: user.id, photos: photosFor(photos), categoryId: category.id });
    if (!suggested.ok) throw new Error(suggested.reason);
    expect(Object.keys(suggested.analysis.normalized.suggestions)).toEqual(
      expect.arrayContaining(["categoryId", "title", "materials", "estimatedAge", "regionOfOrigin"]),
    );

    const result = await submitListing(
      { db, vision },
      { userId: user.id, submission: submission(category.id), photos, aiSuggestionId: suggested.analysis.id, aiAccepted: ["title", "materials"] },
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(vision.requests).toHaveLength(1);
    const analysis = await db.aiAnalysis.findUniqueOrThrow({ where: { id: suggested.analysis.id } });
    expect(analysis.listingId).toBe(result.listingId);
    expect(analysis.sellerDecisions).toMatchObject({ previewed: true, accepted: ["title", "materials"] });
    expect((analysis.sellerDecisions as { rejected: string[] }).rejected).toEqual(
      expect.arrayContaining(["categoryId", "estimatedAge", "regionOfOrigin"]),
    );
  });

  it("runs a fresh analysis when the photos changed, and never reuses another seller's run", async () => {
    const vision = new FakeVisionProvider();
    const [a, b] = [await seller(), await seller()];
    const category = await createCategory(db);
    const photos = testPhotos(1);
    const suggested = await suggestFromPhotos({ db, vision }, { userId: a.id, photos: photosFor(photos), categoryId: category.id });
    if (!suggested.ok) throw new Error(suggested.reason);

    const changed = await submitListing(
      { db, vision },
      { userId: a.id, submission: submission(category.id), photos: testPhotos(1), aiSuggestionId: suggested.analysis.id },
    );
    const stolen = await submitListing(
      { db, vision },
      { userId: b.id, submission: submission(category.id), photos, aiSuggestionId: suggested.analysis.id },
    );
    if (!changed.ok || !stolen.ok) throw new Error("submit failed");
    expect(vision.requests).toHaveLength(3);
    expect((await db.aiAnalysis.findUniqueOrThrow({ where: { id: suggested.analysis.id } })).listingId).toBeNull();
  });

  it("re-applies the guardrails without a model call when the seller switched to a Native American category", async () => {
    const vision = new FakeVisionProvider();
    const user = await seller();
    const plain = await createCategory(db);
    const native = await createCategory(db, { isNativeAmerican: true });
    const photos = testPhotos(1);
    const suggested = await suggestFromPhotos({ db, vision }, { userId: user.id, photos: photosFor(photos), categoryId: plain.id });
    if (!suggested.ok) throw new Error(suggested.reason);
    expect(suggested.analysis.uncertainty).toBe("MEDIUM");

    const result = await submitListing(
      { db, vision },
      {
        userId: user.id,
        submission: submission(native.id, {
          regionOfOrigin: "Ohio River valley",
          estimatedAge: "Archaic",
          materials: "Chert",
          acquisitionState: "KY",
          acquisitionYearApprox: 2001,
          iacaAcknowledged: true,
        }),
        photos,
        aiSuggestionId: suggested.analysis.id,
      },
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(vision.requests).toHaveLength(1);
    const attached = await db.aiAnalysis.findFirstOrThrow({ where: { listingId: result.listingId } });
    expect(attached.id).not.toBe(suggested.analysis.id);
    expect(attached.uncertainty).toBe("HIGH");
    expect(attached.guardrailActions).toEqual(expect.arrayContaining(["FORCED_HIGH_UNCERTAINTY", "REEVALUATED_FOR_CATEGORY"]));
  });

  it("routes red-flagged items to compliance and requires written notes to approve them", async () => {
    const vision = new FakeVisionProvider();
    vision.respond = () => ({
      identification: { label: "Carved bone pendant", confidence: 0.6 },
      observations: ["Porous texture consistent with bone"],
      redFlags: [{ flag: "POSSIBLE_HUMAN_REMAINS", evidence: "Material may be human bone" }],
      uncertainty: "MEDIUM",
    });
    const user = await seller();
    const category = await createCategory(db);
    const result = await submitListing({ db, vision }, { userId: user.id, submission: submission(category.id), photos: testPhotos() });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const review = await db.complianceReview.findUniqueOrThrow({ where: { id: result.reviewId } });
    expect(review.reason).toBe("AI_FLAG");
    expect(review.flags).toMatchObject({ ai: { blocksPublishing: true, redFlags: ["POSSIBLE_HUMAN_REMAINS"] } });

    const reviewer = await createVerifiedUser(db, { role: "MODERATOR" });
    expect(
      await decideListingReview({ db }, { reviewerId: reviewer.id, reviewId: result.reviewId, decision: "APPROVE", notes: "looks ok" }),
    ).toEqual({ ok: false, reason: "AI_FLAG_NOTES_REQUIRED" });
    expect((await db.listing.findUniqueOrThrow({ where: { id: result.listingId } })).status).toBe("PENDING_REVIEW");
    const approved = await decideListingReview(
      { db },
      {
        reviewerId: reviewer.id,
        reviewId: result.reviewId,
        decision: "APPROVE",
        notes: "Inspected in hand: cast resin replica, no bone. Seller supplied receipt.",
      },
    );
    expect(approved).toEqual({ ok: true, listingStatus: "LIVE" });
  });

  it("still queues the listing when the provider fails or returns garbage", async () => {
    const user = await seller();
    const category = await createCategory(db);
    const down = new FakeVisionProvider();
    down.fail = true;
    const r1 = await submitListing({ db, vision: down }, { userId: user.id, submission: submission(category.id), photos: testPhotos() });
    const garbage = new FakeVisionProvider();
    garbage.respond = () => ({ uncertainty: "CERTAIN", authenticated: true });
    const r2 = await submitListing({ db, vision: garbage }, { userId: user.id, submission: submission(category.id), photos: testPhotos() });
    if (!r1.ok || !r2.ok) throw new Error("submit failed");
    const [a1, a2] = await Promise.all(
      [r1, r2].map((r) => db.aiAnalysis.findFirstOrThrow({ where: { listingId: r.listingId } })),
    );
    expect(a1).toMatchObject({ uncertainty: "HIGH", flags: ["ANALYZER_UNAVAILABLE"], blocksPublishing: false });
    expect(a1.error).toMatch(/outage/);
    expect(a2).toMatchObject({ uncertainty: "HIGH", flags: ["INVALID_OUTPUT"] });
    expect(a2.guardrailActions).toContain("DROPPED_AUTHENTICATION_FIELDS");
  });

  it("rate-limits suggestion runs but never the analysis at submission", async () => {
    const vision = new FakeVisionProvider();
    const user = await seller();
    const category = await createCategory(db);
    const deps = { db, vision, dailyLimit: 2 };
    for (let i = 0; i < 2; i++) {
      expect((await suggestFromPhotos(deps, { userId: user.id, photos: photosFor(testPhotos()) })).ok).toBe(true);
    }
    expect(await suggestFromPhotos(deps, { userId: user.id, photos: photosFor(testPhotos()) })).toEqual({ ok: false, reason: "RATE_LIMITED" });
    const result = await submitListing({ db, vision }, { userId: user.id, submission: submission(category.id), photos: testPhotos() });
    expect(result.ok).toBe(true);
  });

  it("keeps analysis output immutable and feeds the AI value range into the sales-outcome record", async () => {
    const vision = new FakeVisionProvider();
    const user = await seller();
    const category = await createCategory(db);
    const result = await submitListing({ db, vision }, { userId: user.id, submission: submission(category.id), photos: testPhotos() });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const analysis = await db.aiAnalysis.findFirstOrThrow({ where: { listingId: result.listingId } });
    await expect(db.aiAnalysis.update({ where: { id: analysis.id }, data: { uncertainty: "LOW" } })).rejects.toThrow(/immutable/);
    await expect(db.aiAnalysis.update({ where: { id: analysis.id }, data: { listingId: null } })).rejects.toThrow(/already attached/);
    await expect(db.aiAnalysis.delete({ where: { id: analysis.id } })).rejects.toThrow(/immutable/);

    await db.$transaction((tx) => recordListingOutcome(tx, { listingId: result.listingId, outcome: "WITHDRAWN", closedAt: new Date() }));
    const outcome = await db.listingOutcome.findUniqueOrThrow({ where: { listingId: result.listingId } });
    expect(outcome).toMatchObject({ aiValueLowCents: 4000, aiValueHighCents: 12000, aiUncertainty: "MEDIUM" });
  });
});
