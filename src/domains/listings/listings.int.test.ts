import { beforeAll, afterAll, describe, expect, it } from "vitest";
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
import { createStorefront, submitListing } from "./listings";
import type { ListingSubmission } from "./rules";

const db = testDb();
const deps = { db };
beforeAll(() => ensureProvenanceTemplate(db));
afterAll(() => db.$disconnect());

let slugCounter = 0;
async function verifiedSeller(legalName = "Jane Q Seller") {
  const user = await createVerifiedUser(db);
  await markIdentityVerified(db, user.id, legalName);
  const store = await createStorefront(deps, { userId: user.id, name: "Jane's Finds", slug: `janes-finds-${Date.now()}-${slugCounter++}` });
  if (!store.ok) throw new Error(store.reason);
  return user;
}

function submission(categoryId: string, overrides: Partial<ListingSubmission> = {}): ListingSubmission {
  return {
    categoryId,
    title: "Archaic side-notched point",
    description: "Chert side-notched point, about 2 inches, small tip ding.",
    askingPrice: 12_500,
    shipping: 800,
    regionOfOrigin: "Ohio River valley",
    estimatedAge: "Early Archaic",
    materials: "Flint Ridge chert",
    sellerConditionGrade: "Very good",
    acquisitionSource: "PRIVATE_LAND_WITH_PERMISSION",
    acquisitionState: "KY",
    acquisitionYearApprox: 1995,
    acquisitionDetails: "Surface find on my uncle's farm in Boone County after plowing.",
    landownerName: "Robert Seller",
    attestationKeys: PROVENANCE_TEMPLATE_V2.attestations.map((a) => a.key),
    iacaAcknowledged: true,
    signedName: "jane q. seller",
    ...overrides,
  };
}

describe("storefronts", () => {
  it("require a verified identity", async () => {
    const user = await createVerifiedUser(db);
    expect(await createStorefront(deps, { userId: user.id, name: "Nope", slug: "nope-store" })).toEqual({
      ok: false,
      reason: "NOT_VERIFIED",
    });
  });

  it("are one per seller and audited", async () => {
    const user = await verifiedSeller();
    const store = await db.storefront.findFirstOrThrow({ where: { ownerUserId: user.id } });
    const audit = await db.auditEvent.findFirst({ where: { subjectId: store.id } });
    expect(audit?.action).toBe("storefront.created");
    expect(await createStorefront(deps, { userId: user.id, name: "Second", slug: `second-${store.id}` })).toEqual({
      ok: false,
      reason: "ALREADY_HAS_STOREFRONT",
    });
  });
});

describe("listing submission with a sworn provenance statement", () => {
  it("queues a valid Native American listing for review with a signed, immutable statement", async () => {
    const seller = await verifiedSeller();
    const category = await createCategory(db, { isNativeAmerican: true, requiresEnhancedReview: true });
    const result = await submitListing(deps, { photos: testPhotos(), userId: seller.id, submission: submission(category.id) });
    if (!result.ok) throw new Error(JSON.stringify(result));

    const listing = await db.listing.findUniqueOrThrow({
      where: { id: result.listingId },
      include: { provenanceStatements: true, complianceReviews: true },
    });
    expect(listing.status).toBe("PENDING_REVIEW");
    expect(listing.askingPriceCents).toBe(12_500);
    const [statement] = listing.provenanceStatements;
    expect(statement.signatureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(statement.iacaDisclosureAcknowledged).toBe(true);
    expect(statement.landownerName).toBe("Robert Seller");
    expect(statement.attestationKeys).toHaveLength(PROVENANCE_TEMPLATE_V2.attestations.length);
    expect(listing.complianceReviews[0].reason).toBe("CATEGORY");

    const actions = (
      await db.auditEvent.findMany({
        where: { subjectId: { in: [listing.id, statement.id, listing.complianceReviews[0].id] } },
        orderBy: { seq: "asc" },
      })
    ).map((e) => e.action);
    expect(actions).toEqual(["listing.submitted", "provenance.signed", "compliance.review_opened"]);

    await expect(
      db.provenanceStatement.update({ where: { id: statement.id }, data: { signedName: "Someone Else" } }),
    ).rejects.toThrow(/immutable/);
    await expect(db.provenanceStatement.delete({ where: { id: statement.id } })).rejects.toThrow(/immutable/);
  });

  it("requires the extra Native American fields and the IACA acknowledgement", async () => {
    const seller = await verifiedSeller();
    const category = await createCategory(db, { isNativeAmerican: true });
    const result = await submitListing(deps, { photos: testPhotos(),
      userId: seller.id,
      submission: submission(category.id, {
        regionOfOrigin: undefined,
        materials: undefined,
        estimatedAge: undefined,
        iacaAcknowledged: false,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "INVALID") throw new Error("expected INVALID");
    expect(result.issues.map((i) => i.field).sort()).toEqual(
      ["estimatedAge", "iacaAcknowledged", "materials", "regionOfOrigin"].sort(),
    );
  });

  it("requires every attestation and a signature matching the verified legal name", async () => {
    const seller = await verifiedSeller();
    const category = await createCategory(db);
    const result = await submitListing(deps, { photos: testPhotos(),
      userId: seller.id,
      submission: submission(category.id, {
        attestationKeys: PROVENANCE_TEMPLATE_V2.attestations.slice(1).map((a) => a.key),
        signedName: "Not The Seller",
      }),
    });
    if (result.ok || result.reason !== "INVALID") throw new Error("expected INVALID");
    expect(result.issues.map((i) => i.field).sort()).toEqual(["attestationKeys", "signedName"]);
  });

  it("refuses banned items outright, creates nothing, and audits the attempt", async () => {
    const seller = await verifiedSeller();
    const category = await createCategory(db);
    const before = await db.listing.count({ where: { sellerUserId: seller.id } });
    const result = await submitListing(deps, { photos: testPhotos(),
      userId: seller.id,
      submission: submission(category.id, { description: "Rare grave goods recovered from a burial mound in 1960." }),
    });
    if (result.ok || result.reason !== "PROHIBITED") throw new Error("expected PROHIBITED");
    expect(result.matches.map((m) => m.reason)).toContain("Funerary objects are banned");
    expect(await db.listing.count({ where: { sellerUserId: seller.id } })).toBe(before);
    const audit = await db.auditEvent.findFirst({
      where: { actorUserId: seller.id, action: "listing.submission_blocked" },
    });
    expect(audit).not.toBeNull();
  });

  it("flags review-level wording for the reviewer instead of blocking", async () => {
    const seller = await verifiedSeller();
    const category = await createCategory(db);
    const result = await submitListing(deps, { photos: testPhotos(),
      userId: seller.id,
      submission: submission(category.id, { title: "Ceremonial style pipe bowl replica" }),
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const review = await db.complianceReview.findUniqueOrThrow({ where: { id: result.reviewId } });
    expect(review.reason).toBe("KEYWORD");
    expect(JSON.stringify(review.flags)).toContain("ceremonial");
  });

  it("refuses categories in verticals that aren't open yet (antiques)", async () => {
    const seller = await verifiedSeller();
    const category = await createCategory(db, { vertical: "ANTIQUE" });
    expect(await submitListing(deps, { photos: testPhotos(), userId: seller.id, submission: submission(category.id) })).toEqual({
      ok: false,
      reason: "CATEGORY_UNAVAILABLE",
    });
  });

  it("refuses unverified sellers", async () => {
    const user = await createVerifiedUser(db);
    const category = await createCategory(db);
    expect(await submitListing(deps, { photos: testPhotos(), userId: user.id, submission: submission(category.id) })).toEqual({
      ok: false,
      reason: "NOT_VERIFIED",
    });
  });
});

describe("compliance review", () => {
  it("staff approve to LIVE; sellers can't approve their own listing; decisions are final and audited", async () => {
    const seller = await verifiedSeller();
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const category = await createCategory(db);
    const result = await submitListing(deps, { photos: testPhotos(), userId: seller.id, submission: submission(category.id) });
    if (!result.ok) throw new Error(JSON.stringify(result));

    const decision = { reviewId: result.reviewId, decision: "APPROVE" as const, notes: "" };
    expect(await decideListingReview(deps, { ...decision, reviewerId: seller.id })).toEqual({
      ok: false,
      reason: "NOT_STAFF",
    });
    await db.user.update({ where: { id: seller.id }, data: { role: "MODERATOR" } });
    expect(await decideListingReview(deps, { ...decision, reviewerId: seller.id })).toEqual({
      ok: false,
      reason: "SELF_REVIEW",
    });

    expect(await decideListingReview(deps, { ...decision, reviewerId: owner.id })).toEqual({
      ok: true,
      listingStatus: "LIVE",
    });
    const listing = await db.listing.findUniqueOrThrow({ where: { id: result.listingId } });
    expect(listing.status).toBe("LIVE");
    expect(listing.publishedAt).not.toBeNull();
    expect(await decideListingReview(deps, { ...decision, reviewerId: owner.id })).toEqual({
      ok: false,
      reason: "ALREADY_DECIDED",
    });
    const audit = await db.auditEvent.findFirst({ where: { subjectId: result.reviewId, action: "compliance.listing_approved" } });
    expect(audit?.actorUserId).toBe(owner.id);
  });

  it("rejection needs notes", async () => {
    const seller = await verifiedSeller();
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const category = await createCategory(db);
    const result = await submitListing(deps, { photos: testPhotos(), userId: seller.id, submission: submission(category.id) });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const decision = { reviewerId: owner.id, reviewId: result.reviewId, decision: "REJECT" as const };
    expect(await decideListingReview(deps, { ...decision, notes: "" })).toEqual({ ok: false, reason: "NOTES_REQUIRED" });
    expect(await decideListingReview(deps, { ...decision, notes: "Photos show soil staining consistent with a burial." })).toEqual({
      ok: true,
      listingStatus: "REJECTED",
    });
  });
});

describe("database guards", () => {
  it("a listing can't go LIVE without a signed statement from a verified seller", async () => {
    const seller = await verifiedSeller();
    const category = await createCategory(db);
    const store = await db.storefront.findFirstOrThrow({ where: { ownerUserId: seller.id } });
    const base = {
      storefrontId: store.id,
      sellerUserId: seller.id,
      categoryId: category.id,
      title: "Direct insert",
      description: "Bypassing the app",
      format: "FIXED" as const,
      askingPriceCents: 1000,
    };
    await expect(
      db.listing.create({ data: { ...base, status: "LIVE", publishedAt: new Date() } }),
    ).rejects.toThrow(/provenance statement/);

    const result = await submitListing(deps, { photos: testPhotos(), userId: seller.id, submission: submission(category.id) });
    if (!result.ok) throw new Error(JSON.stringify(result));
    await db.identityVerification.update({ where: { userId: seller.id }, data: { status: "REJECTED" } });
    await expect(
      db.listing.update({ where: { id: result.listingId }, data: { status: "LIVE", publishedAt: new Date() } }),
    ).rejects.toThrow(/not verified/);
  });

  it("template wording can't be edited in place, and approval needs an approver", async () => {
    const template = await ensureProvenanceTemplate(db);
    await expect(
      db.provenanceStatementTemplate.update({ where: { id: template.id }, data: { body: "Edited" } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.provenanceStatementTemplate.update({ where: { id: template.id }, data: { isDraft: false } }),
    ).rejects.toThrow();
    await expect(db.provenanceStatementTemplate.delete({ where: { id: template.id } })).rejects.toThrow();
  });

  it("an order's amounts must add up under the two-sided fee model", async () => {
    const seller = await verifiedSeller();
    const buyer = await createVerifiedUser(db);
    const category = await createCategory(db);
    const store = await db.storefront.findFirstOrThrow({ where: { ownerUserId: seller.id } });
    const listing = await db.listing.create({
      data: {
        storefrontId: store.id,
        sellerUserId: seller.id,
        categoryId: category.id,
        title: "Order guard",
        description: "For the order CHECK constraints",
        format: "FIXED",
        askingPriceCents: 10_000,
      },
    });
    const order = {
      listingId: listing.id,
      buyerUserId: buyer.id,
      sellerUserId: seller.id,
      storefrontId: store.id,
      source: "FIXED" as const,
      askingPriceCents: 10_000,
      buyerFeeBps: 1000,
      buyerFeeCents: 1000,
      buyerPriceCents: 11_000,
      sellerFeeBps: 1000,
      sellerFeeCents: 1000,
      sellerPayoutCents: 9000,
      platformFeeCents: 2000,
    };
    await expect(db.order.create({ data: { ...order, buyerPriceCents: 11_500 } })).rejects.toThrow();
    await expect(db.order.create({ data: { ...order, sellerPayoutCents: 10_000 } })).rejects.toThrow();
    await expect(db.order.create({ data: { ...order, platformFeeCents: 1000 } })).rejects.toThrow();
    await expect(db.order.create({ data: order })).resolves.toMatchObject({ buyerPriceCents: 11_000 });
  });
});
