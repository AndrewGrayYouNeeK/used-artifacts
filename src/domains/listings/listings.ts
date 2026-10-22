import { z } from "zod";
import type { Db } from "@/lib/db";
import type { ComplianceReviewReason } from "@/generated/prisma/enums";
import { canonicalJson, sha256Hex } from "@/lib/crypto";
import { isVerticalEnabled, platform, type PlatformConfig } from "@/config/platform";
import { writeAuditEvent } from "@/domains/audit/audit";
import type { RequestContext } from "@/domains/identity/accounts";
import { checkIdentityGate, type IdentityGate } from "@/domains/identity/verification/verification";
import {
  CORE_ATTESTATIONS,
  isAttestationList,
  type Attestation,
} from "@/domains/compliance/provenance-template";
import { screenFields, screeningTerms, type ScreeningMatch } from "@/domains/compliance/screening";
import { raiseFraudSignal, stronglyLinkedUserIds } from "@/domains/trust/linkage";
import { checkListingRules, type ListingSubmission, type RuleIssue } from "./rules";
import { hammingDistance, MAX_PHOTOS, type PreparedPhoto } from "./photos";

export interface ListingDeps {
  db: Db;
  now?: () => Date;
  platform?: PlatformConfig;
}

const clock = (deps: ListingDeps) => (deps.now ? deps.now() : new Date());

type GateFailure = Extract<IdentityGate, { ok: false }>["reason"];

const RESERVED_SLUGS = new Set(["admin", "api", "account", "sell", "listings", "login", "signup", "support", "help", "about"]);

export const StorefrontSchema = z.object({
  name: z.string().trim().min(3, { error: "Store name must be at least 3 characters." }).max(60),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/, {
      error: "Use 3–40 lowercase letters, numbers, and dashes.",
    })
    .refine((s) => !RESERVED_SLUGS.has(s), { error: "That address is reserved." }),
});

export type CreateStorefrontResult =
  | { ok: true; storefrontId: string; slug: string }
  | { ok: false; reason: GateFailure | "ALREADY_HAS_STOREFRONT" | "SLUG_TAKEN" };

export async function createStorefront(
  deps: ListingDeps,
  input: { userId: string; name: string; slug: string },
  ctx: RequestContext = {},
): Promise<CreateStorefrontResult> {
  const gate = await checkIdentityGate(deps.db, input.userId, "SELL");
  if (!gate.ok) return { ok: false, reason: gate.reason };
  if (await deps.db.storefront.findFirst({ where: { ownerUserId: input.userId } })) {
    return { ok: false, reason: "ALREADY_HAS_STOREFRONT" };
  }
  if (await deps.db.storefront.findUnique({ where: { slug: input.slug } })) {
    return { ok: false, reason: "SLUG_TAKEN" };
  }
  const storefront = await deps.db.$transaction(async (tx) => {
    const created = await tx.storefront.create({
      data: {
        name: input.name,
        slug: input.slug,
        ownerUserId: input.userId,
        members: { create: { userId: input.userId, role: "OWNER" } },
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.userId,
      actorType: "USER",
      action: "storefront.created",
      subjectType: "Storefront",
      subjectId: created.id,
      after: { name: created.name, slug: created.slug },
      ipHash: ctx.ipHash,
    });
    return created;
  });
  return { ok: true, storefrontId: storefront.id, slug: storefront.slug };
}

export async function currentProvenanceTemplate(db: Db, now: Date = new Date()) {
  const template = await db.provenanceStatementTemplate.findFirst({
    where: { effectiveAt: { lte: now } },
    orderBy: { version: "desc" },
  });
  if (!template || !isAttestationList(template.attestations) || template.attestations.length === 0) {
    throw new Error("No usable provenance statement template is seeded.");
  }
  return { ...template, attestations: template.attestations as Attestation[] };
}

export async function loadScreeningTerms(db: Db) {
  const rows = await db.prohibitedTerm.findMany({
    select: { pattern: true, isRegex: true, severity: true, reason: true },
  });
  return screeningTerms(rows);
}

export type SubmitListingResult =
  | { ok: true; listingId: string; reviewId: string }
  | { ok: false; reason: GateFailure | "NO_STOREFRONT" | "CATEGORY_UNAVAILABLE" | "PHOTOS_REQUIRED" }
  | { ok: false; reason: "INVALID"; issues: RuleIssue[] }
  | { ok: false; reason: "PROHIBITED"; matches: ScreeningMatch[] };

/**
 * Creates the listing and its signed provenance statement together and queues
 * it for compliance review. During the beta every listing is reviewed before
 * it can go live; nothing here publishes.
 */
export async function submitListing(
  deps: ListingDeps,
  input: { userId: string; submission: ListingSubmission; photos: PreparedPhoto[] },
  ctx: RequestContext = {},
): Promise<SubmitListingResult> {
  const config = deps.platform ?? platform;
  const now = clock(deps);
  const s = input.submission;
  if (input.photos.length === 0 || input.photos.length > MAX_PHOTOS) return { ok: false, reason: "PHOTOS_REQUIRED" };

  const gate = await checkIdentityGate(deps.db, input.userId, "SELL");
  if (!gate.ok) return { ok: false, reason: gate.reason };

  const storefront = await deps.db.storefront.findFirst({
    where: { ownerUserId: input.userId, status: "ACTIVE" },
  });
  if (!storefront) return { ok: false, reason: "NO_STOREFRONT" };

  const category = await deps.db.category.findUnique({ where: { id: s.categoryId } });
  if (!category || !category.parentId || !isVerticalEnabled(category.vertical, config)) {
    return { ok: false, reason: "CATEGORY_UNAVAILABLE" };
  }

  const template = await currentProvenanceTemplate(deps.db, now);
  const issues = checkListingRules(s, {
    category,
    attestations: template.attestations,
    verifiedLegalName: gate.legalName,
    now,
  });
  if (issues.length > 0) return { ok: false, reason: "INVALID", issues };

  const screening = screenFields(
    {
      title: s.title,
      description: s.description,
      acquisitionDetails: s.acquisitionDetails,
      materials: s.materials,
      regionOfOrigin: s.regionOfOrigin,
      estimatedAge: s.estimatedAge,
      sellerConditionGrade: s.sellerConditionGrade,
    },
    await loadScreeningTerms(deps.db),
  );
  if (screening.blocked.length > 0) {
    await deps.db.$transaction((tx) =>
      writeAuditEvent(tx, {
        actorUserId: input.userId,
        actorType: "USER",
        action: "listing.submission_blocked",
        subjectType: "Listing",
        after: {
          title: s.title,
          categoryId: category.id,
          matches: screening.blocked.map((m) => ({ field: m.field, pattern: m.pattern, reason: m.reason })),
        },
        ipHash: ctx.ipHash,
      }),
    );
    return { ok: false, reason: "PROHIBITED", matches: screening.blocked };
  }

  const reusedPhotos = await findReusedPhotos(deps.db, input.userId, input.photos);
  const reason: ComplianceReviewReason =
    screening.review.length > 0 ? "KEYWORD" : category.requiresEnhancedReview ? "CATEGORY" : "BETA_FULL_REVIEW";
  const flags = {
    reusedPhotos,
    screening: screening.review.map((m) => ({ field: m.field, pattern: m.pattern, matchedText: m.matchedText, reason: m.reason })),
    enhancedReviewCategory: category.requiresEnhancedReview,
    nativeAmerican: category.isNativeAmerican,
    highValue: s.askingPrice >= config.highValueThresholdCents,
    acquisitionSource: s.acquisitionSource,
  };

  return deps.db.$transaction(async (tx) => {
    const listing = await tx.listing.create({
      data: {
        storefrontId: storefront.id,
        sellerUserId: input.userId,
        categoryId: category.id,
        title: s.title,
        description: s.description,
        sellerConditionGrade: s.sellerConditionGrade ?? null,
        regionOfOrigin: s.regionOfOrigin ?? null,
        estimatedAge: s.estimatedAge ?? null,
        materials: s.materials ?? null,
        format: "FIXED",
        askingPriceCents: s.askingPrice,
        shippingCents: s.shipping,
        status: "PENDING_REVIEW",
        photos: {
          create: input.photos.map((p, i) => ({
            storageKey: p.storageKey,
            pHash: p.pHash,
            width: p.width,
            height: p.height,
            sortOrder: i,
          })),
        },
      },
    });
    await tx.itemFingerprint.create({
      data: {
        listingId: listing.id,
        pHashes: input.photos.map((p) => p.pHash),
        textHash: itemTextHash(s.title, s.description),
      },
    });

    const listingSnapshot = {
      title: listing.title,
      description: listing.description,
      categoryId: listing.categoryId,
      askingPriceCents: listing.askingPriceCents,
      regionOfOrigin: listing.regionOfOrigin,
      estimatedAge: listing.estimatedAge,
      materials: listing.materials,
      sellerConditionGrade: listing.sellerConditionGrade,
    };
    const statementFields = {
      acquisitionSource: s.acquisitionSource,
      acquisitionState: s.acquisitionState ?? null,
      acquisitionYearApprox: s.acquisitionYearApprox ?? null,
      acquisitionDetails: s.acquisitionDetails,
      landownerName: s.landownerName ?? null,
      attestationKeys: template.attestations.map((a) => a.key),
      iacaDisclosureAcknowledged: category.isNativeAmerican ? s.iacaAcknowledged : false,
    };
    const signedAt = now;
    const signatureHash = sha256Hex(
      canonicalJson({
        sellerUserId: input.userId,
        listingId: listing.id,
        template: { id: template.id, version: template.version, body: template.body, attestations: template.attestations },
        listingSnapshot,
        statement: statementFields,
        signedName: s.signedName,
        signedAt: signedAt.toISOString(),
      }),
    );
    const statement = await tx.provenanceStatement.create({
      data: {
        listingId: listing.id,
        sellerUserId: input.userId,
        templateId: template.id,
        ...statementFields,
        attestsNotFederalStateOrTribalLand: true,
        attestsNotHumanRemainsFuneralSacredPatrimony: true,
        attestsNotIndianMadeMisrepresented: true,
        listingSnapshot,
        signedName: s.signedName,
        signedAt,
        ip: ctx.ipHash ?? null,
        userAgent: ctx.userAgent?.slice(0, 512) ?? null,
        signatureHash,
      },
    });
    const review = await tx.complianceReview.create({
      data: { listingId: listing.id, reason, flags },
    });

    const actor = { actorUserId: input.userId, actorType: "USER" as const, ipHash: ctx.ipHash };
    await writeAuditEvent(tx, {
      ...actor,
      action: "listing.submitted",
      subjectType: "Listing",
      subjectId: listing.id,
      after: { ...listingSnapshot, status: "PENDING_REVIEW" },
    });
    await writeAuditEvent(tx, {
      ...actor,
      action: "provenance.signed",
      subjectType: "ProvenanceStatement",
      subjectId: statement.id,
      after: {
        listingId: listing.id,
        templateVersion: template.version,
        templateIsDraft: template.isDraft,
        acquisitionSource: s.acquisitionSource,
        signatureHash,
        coreAttestations: Object.values(CORE_ATTESTATIONS),
      },
    });
    const otherSellers = [...new Set(reusedPhotos.filter((r) => r.sellerUserId !== input.userId).map((r) => r.sellerUserId))];
    if (otherSellers.length > 0) {
      await raiseFraudSignal(tx, {
        detector: "SELF_RESALE",
        subjectType: "Listing",
        subjectId: listing.id,
        score: reusedPhotos.some((r) => r.linkedSeller) ? 80 : 50,
        evidence: { sellerUserId: input.userId, matches: reusedPhotos },
      });
    }
    await writeAuditEvent(tx, {
      actorType: "SYSTEM",
      action: "compliance.review_opened",
      subjectType: "ComplianceReview",
      subjectId: review.id,
      after: { listingId: listing.id, reason, flags },
    });
    return { ok: true, listingId: listing.id, reviewId: review.id } as const;
  });
}

export function itemTextHash(title: string, description: string): string {
  return sha256Hex(`${title} ${description}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
}

const NEAR_DUPLICATE_BITS = 6;

export type ReusedPhoto = {
  listingId: string;
  sellerUserId: string;
  pHash: string;
  distance: number;
  /** The other listing belongs to an account strongly linked to this seller. */
  linkedSeller: boolean;
};

/**
 * Photos that already appear on another listing: exact hash matches anywhere,
 * and near matches among listings by the seller or accounts linked to them.
 * Shown to the compliance reviewer (self-reselling, stolen photos).
 */
export async function findReusedPhotos(db: Db, sellerUserId: string, photos: PreparedPhoto[]): Promise<ReusedPhoto[]> {
  const linked = await stronglyLinkedUserIds(db, sellerUserId);
  const hashes = photos.map((p) => p.pHash);
  const candidates = await db.listingPhoto.findMany({
    where: {
      OR: [{ pHash: { in: hashes } }, { listing: { sellerUserId: { in: [sellerUserId, ...linked] } } }],
      pHash: { not: null },
    },
    select: { pHash: true, listing: { select: { id: true, sellerUserId: true } } },
    take: 2000,
  });
  const matches = new Map<string, ReusedPhoto>();
  for (const c of candidates) {
    const distance = Math.min(...hashes.map((h) => hammingDistance(h, c.pHash!)));
    if (distance > NEAR_DUPLICATE_BITS) continue;
    const prior = matches.get(c.listing.id);
    if (prior && prior.distance <= distance) continue;
    matches.set(c.listing.id, {
      listingId: c.listing.id,
      sellerUserId: c.listing.sellerUserId,
      pHash: c.pHash!,
      distance,
      linkedSeller: linked.includes(c.listing.sellerUserId),
    });
  }
  return [...matches.values()];
}
