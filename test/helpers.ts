import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@/lib/db";
import { MemoryMailer } from "@/lib/email/mailer";
import { hashPassword } from "@/lib/auth/password";
import type { IdentityDeps } from "@/domains/identity/accounts";
import type { UserRole, Vertical } from "@/generated/prisma/enums";
import { PROVENANCE_TEMPLATE_V2 } from "@/domains/compliance/provenance-template";

export function testDb(): Db {
  return createDb(process.env.TEST_DATABASE_URL!);
}

export function testDeps(db: Db, now?: () => Date): IdentityDeps & { mailer: MemoryMailer } {
  return { db, mailer: new MemoryMailer(), appUrl: "http://test.local", now };
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
