import { randomBytes, randomUUID } from "node:crypto";
import { createDb, type Db } from "@/lib/db";
import { MemoryMailer } from "@/lib/email/mailer";
import { hashPassword } from "@/lib/auth/password";
import type { IdentityDeps } from "@/domains/identity/accounts";
import type { UserRole, Vertical } from "@/generated/prisma/enums";
import { PROVENANCE_TEMPLATE_V2 } from "@/domains/compliance/provenance-template";
import { decideListingReview } from "@/domains/compliance/review";
import { submitListing } from "@/domains/listings/listings";
import { FakeVisionProvider } from "@/domains/ai/fake-vision";
import { loadPlatformConfig } from "@/config/platform";

export const TEST_TWO_FACTOR_KEY = "test-two-factor-key-test-two-factor-key-0000";

export function testDb(): Db {
  return createDb(process.env.TEST_DATABASE_URL!);
}

export function testDeps(db: Db, now?: () => Date): IdentityDeps & { mailer: MemoryMailer } {
  return {
    db,
    mailer: new MemoryMailer(),
    appUrl: "http://test.local",
    now,
    twoFactorKey: TEST_TWO_FACTOR_KEY,
    platform: loadPlatformConfig({ BETA_INVITE_REQUIRED: "false" }),
  };
}

export function uniqueEmail(prefix = "user") {
  return `${prefix}-${randomUUID()}@example.com`;
}

export async function createVerifiedUser(
  db: Db,
  opts: { email?: string; password?: string; role?: UserRole } = {},
) {
  return db.user.create({
    data: {
      email: (opts.email ?? uniqueEmail()).trim().toLowerCase(),
      displayName: "Test User",
      passwordHash: await hashPassword(opts.password ?? "correct horse battery"),
      emailVerifiedAt: new Date(),
      role: opts.role ?? "USER",
    },
  });
}

export function extractToken(text: string): string {
  const match = text.match(/token=([^\s]+)/);
  if (!match) throw new Error(`No token link in email: ${text}`);
  return decodeURIComponent(match[1]);
}

export async function ensureProvenanceTemplate(db: Db) {
  const existing = await db.provenanceStatementTemplate.findUnique({
    where: { version: PROVENANCE_TEMPLATE_V2.version },
  });
  if (existing) return existing;
  return db.provenanceStatementTemplate.create({
    data: {
      version: PROVENANCE_TEMPLATE_V2.version,
      body: PROVENANCE_TEMPLATE_V2.body,
      attestations: PROVENANCE_TEMPLATE_V2.attestations.map((a) => ({ ...a })),
      effectiveAt: new Date(Date.now() - 60_000),
    },
  });
}

export async function createCategory(
  db: Db,
  opts: { vertical?: Vertical; isNativeAmerican?: boolean; requiresEnhancedReview?: boolean } = {},
) {
  const suffix = randomUUID().slice(0, 8);
  const parent = await db.category.create({
    data: {
      name: `Parent ${suffix}`,
      slug: `parent-${suffix}`,
      vertical: opts.vertical ?? "ARTIFACT",
      isNativeAmerican: opts.isNativeAmerican ?? false,
      requiresEnhancedReview: opts.requiresEnhancedReview ?? false,
    },
  });
  return db.category.create({
    data: {
      name: `Leaf ${suffix}`,
      slug: `leaf-${suffix}`,
      parentId: parent.id,
      vertical: parent.vertical,
      isNativeAmerican: parent.isNativeAmerican,
      requiresEnhancedReview: parent.requiresEnhancedReview,
    },
  });
}

/** Marks a user as ID-verified without going through a provider. */
export async function markIdentityVerified(db: Db, userId: string, legalName = "Jane Q Seller") {
  return db.identityVerification.create({
    data: {
      userId,
      provider: "fake",
      providerSessionId: `test_${randomUUID()}`,
      status: "VERIFIED",
      verifiedAt: new Date(),
      legalName,
      documentFingerprintHash: randomUUID(),
      personFingerprintHash: randomUUID(),
    },
  });
}

/** Stored-photo stand-ins with random hashes (no image processing in domain tests). */
export function testPhotos(count = 1) {
  return Array.from({ length: count }, () => ({
    storageKey: `listings/test-${randomUUID()}.webp`,
    bytes: new Uint8Array(0),
    pHash: randomBytes(8).toString("hex"),
    width: 1200,
    height: 900,
  }));
}

let storeCounter = 0;

/**
 * A verified seller with a payout-ready storefront and one approved LIVE
 * fixed-price listing (through the real submission and review path).
 */
export async function createLiveListing(
  db: Db,
  opts: { askingPrice?: number; shipping?: number; seller?: { id: string }; photos?: ReturnType<typeof testPhotos> } = {},
) {
  await ensureProvenanceTemplate(db);
  let seller = opts.seller;
  if (!seller) {
    const user = await createVerifiedUser(db);
    await markIdentityVerified(db, user.id);
    await db.storefront.create({
      data: {
        name: "Test Store",
        slug: `store-${Date.now()}-${storeCounter++}`,
        ownerUserId: user.id,
        stripeAccountId: `fake_acct_${randomUUID()}`,
        payoutsEnabled: true,
        members: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    seller = user;
  }
  const category = await createCategory(db);
  const result = await submitListing(
    { db, vision: new FakeVisionProvider() },
    {
      userId: seller.id,
      photos: opts.photos ?? testPhotos(),
      submission: {
        categoryId: category.id,
        title: "Archaic side-notched point",
        description: "Chert side-notched point, about 2 inches, small tip ding.",
        askingPrice: opts.askingPrice ?? 10_000,
        shipping: opts.shipping ?? 0,
        acquisitionSource: "PURCHASED",
        acquisitionDetails: "Bought from a dealer's estate collection in Louisville in 2004.",
        attestationKeys: PROVENANCE_TEMPLATE_V2.attestations.map((a) => a.key),
        iacaAcknowledged: false,
        signedName: "Jane Q Seller",
      },
    },
  );
  if (!result.ok) throw new Error(`submitListing failed: ${JSON.stringify(result)}`);
  const reviewer = await createVerifiedUser(db, { role: "MODERATOR" });
  const decision = await decideListingReview({ db }, { reviewerId: reviewer.id, reviewId: result.reviewId, decision: "APPROVE", notes: "" });
  if (!decision.ok) throw new Error(`review failed: ${JSON.stringify(decision)}`);
  return { seller, listingId: result.listingId, categoryId: category.id };
}
