import { randomBytes } from "node:crypto";
import type { Db } from "@/lib/db";
import type { Mailer } from "@/lib/email/mailer";
import type { AuthenticatorStatus } from "@/generated/prisma/enums";
import { platform, type PlatformConfig } from "@/config/platform";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";
import type { RequestContext } from "@/domains/identity/accounts";

/**
 * Grading Stage 1 (BUILD_PLAN 6.2): 1–2 private partner authenticators look at
 * high-value pieces. Partners don't sign in; the owner assigns the work and
 * records what the partner found. Only AUTHENTICATED is offered: GRADED and
 * MUSEUM_GRADE come with Stage 2 and later (the database refuses them).
 */
export interface GradingDeps {
  db: Db;
  mailer: Mailer;
  appUrl: string;
  platform?: PlatformConfig;
  now?: () => Date;
}

const OPEN_STATUSES = ["SUBMITTED", "RECEIVED", "IN_REVIEW"] as const;
const CERT_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateCertificateNumber(): string {
  const chars = Array.from(randomBytes(10), (b) => CERT_ALPHABET[b % CERT_ALPHABET.length]).join("");
  return `UA-A-${chars.slice(0, 5)}-${chars.slice(5)}`;
}

const clock = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();
const config = (deps: { platform?: PlatformConfig }) => deps.platform ?? platform;

async function isOwner(tx: Tx, userId: string): Promise<boolean> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
  return user?.role === "OWNER" && user.status === "ACTIVE";
}

export type Ineligible = "NOT_LIVE" | "NOT_FIXED_PRICE" | "BELOW_THRESHOLD" | "VERTICAL_CLOSED";

/** Stage 1 covers live fixed-price listings asking at least HIGH_VALUE_THRESHOLD_CENTS. */
export function authenticationEligibility(
  listing: { status: string; format: string; askingPriceCents: number | null; category: { vertical: string } },
  cfg: PlatformConfig = platform,
): Ineligible | null {
  if (listing.status !== "LIVE") return "NOT_LIVE";
  if (listing.format !== "FIXED") return "NOT_FIXED_PRICE";
  if (!(cfg.enabledVerticals as string[]).includes(listing.category.vertical)) return "VERTICAL_CLOSED";
  if ((listing.askingPriceCents ?? 0) < cfg.highValueThresholdCents) return "BELOW_THRESHOLD";
  return null;
}

// ───────────── Authenticators ─────────────

export type AuthenticatorInput = {
  actorId: string;
  name: string;
  organization?: string | null;
  credentials: string;
  specialtyCategoryIds: string[];
  agreementSigned: boolean;
};

export type CreateAuthenticatorResult = { ok: true; authenticatorId: string } | { ok: false; reason: "OWNER_ONLY" | "DETAILS_REQUIRED" | "UNKNOWN_CATEGORY" };

export async function createAuthenticator(
  deps: Pick<GradingDeps, "db" | "now">,
  input: AuthenticatorInput,
  ctx: RequestContext = {},
): Promise<CreateAuthenticatorResult> {
  const name = input.name.trim();
  const credentials = input.credentials.trim();
  if (name.length < 2 || credentials.length < 5) return { ok: false, reason: "DETAILS_REQUIRED" };
  const specialties = [...new Set(input.specialtyCategoryIds)];
  return deps.db.$transaction(async (tx) => {
    if (!(await isOwner(tx, input.actorId))) return { ok: false, reason: "OWNER_ONLY" } as const;
    if (specialties.length && (await tx.category.count({ where: { id: { in: specialties } } })) !== specialties.length) {
      return { ok: false, reason: "UNKNOWN_CATEGORY" } as const;
    }
    const created = await tx.authenticator.create({
      data: {
        name,
        organization: input.organization?.trim() || null,
        credentials,
        specialtyCategoryIds: specialties,
        agreementSignedAt: input.agreementSigned ? clock(deps) : null,
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "grading.authenticator_added",
      subjectType: "Authenticator",
      subjectId: created.id,
      after: { name, organization: created.organization, specialtyCategoryIds: specialties, agreementSigned: input.agreementSigned },
      ipHash: ctx.ipHash,
    });
    return { ok: true, authenticatorId: created.id } as const;
  });
}

export type UpdateAuthenticatorResult = { ok: true } | { ok: false; reason: "OWNER_ONLY" | "NOT_FOUND" | "TERMINATED" };

/** Pause, resume, or end a partner, or record that their contractor agreement is signed. */
export async function updateAuthenticator(
  deps: Pick<GradingDeps, "db" | "now">,
  input: { actorId: string; authenticatorId: string; status?: AuthenticatorStatus; agreementSigned?: true },
  ctx: RequestContext = {},
): Promise<UpdateAuthenticatorResult> {
  return deps.db.$transaction(async (tx) => {
    if (!(await isOwner(tx, input.actorId))) return { ok: false, reason: "OWNER_ONLY" } as const;
    const current = await tx.authenticator.findUnique({ where: { id: input.authenticatorId } });
    if (!current) return { ok: false, reason: "NOT_FOUND" } as const;
    if (current.status === "TERMINATED") return { ok: false, reason: "TERMINATED" } as const;
    const data = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.agreementSigned && !current.agreementSignedAt ? { agreementSignedAt: clock(deps) } : {}),
    };
    await tx.authenticator.update({ where: { id: current.id }, data });
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "grading.authenticator_updated",
      subjectType: "Authenticator",
      subjectId: current.id,
      before: { status: current.status, agreementSigned: current.agreementSignedAt !== null },
      after: { status: input.status ?? current.status, agreementSigned: current.agreementSignedAt !== null || input.agreementSigned === true },
      ipHash: ctx.ipHash,
    });
    return { ok: true } as const;
  });
}

type AssignFailure = "AUTHENTICATOR_UNAVAILABLE" | "NO_AGREEMENT" | "OUTSIDE_SPECIALTY";

async function checkAuthenticator(tx: Tx, authenticatorId: string, categoryId: string): Promise<AssignFailure | null> {
  const partner = await tx.authenticator.findUnique({ where: { id: authenticatorId } });
  if (!partner || partner.status !== "ACTIVE") return "AUTHENTICATOR_UNAVAILABLE";
  if (!partner.agreementSignedAt) return "NO_AGREEMENT";
  if (partner.specialtyCategoryIds.length > 0) {
    const category = await tx.category.findUniqueOrThrow({ where: { id: categoryId }, select: { id: true, parentId: true } });
    if (!partner.specialtyCategoryIds.some((id) => id === category.id || id === category.parentId)) return "OUTSIDE_SPECIALTY";
  }
  return null;
}

// ───────────── Requests and assignment ─────────────

export type RequestAuthenticationResult =
  | { ok: true; submissionId: string }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_REQUESTED" | "ALREADY_AUTHENTICATED" | Ineligible };

async function openOrPublished(tx: Tx, listingId: string): Promise<"ALREADY_REQUESTED" | "ALREADY_AUTHENTICATED" | null> {
  const open = await tx.gradingSubmission.count({ where: { listingId, status: { in: [...OPEN_STATUSES] } } });
  if (open) return "ALREADY_REQUESTED";
  const published = await tx.gradingResult.count({ where: { status: "PUBLISHED", submission: { listingId } } });
  return published ? "ALREADY_AUTHENTICATED" : null;
}

/** A seller asks for partner authentication of their own high-value listing (free during the beta). */
export async function requestAuthentication(
  deps: Pick<GradingDeps, "db" | "platform">,
  input: { sellerUserId: string; listingId: string; notes?: string | null },
  ctx: RequestContext = {},
): Promise<RequestAuthenticationResult> {
  return deps.db.$transaction(async (tx) => {
    const listing = await tx.listing.findUnique({ where: { id: input.listingId }, include: { category: { select: { vertical: true } } } });
    if (!listing || listing.sellerUserId !== input.sellerUserId) return { ok: false, reason: "NOT_FOUND" } as const;
    const ineligible = authenticationEligibility(listing, config(deps));
    if (ineligible) return { ok: false, reason: ineligible } as const;
    const existing = await openOrPublished(tx, listing.id);
    if (existing) return { ok: false, reason: existing } as const;
    const submission = await tx.gradingSubmission.create({
      data: {
        listingId: listing.id,
        ownerUserId: listing.sellerUserId,
        categoryId: listing.categoryId,
        requestedTier: "AUTHENTICATED",
        feeCents: 0,
        notes: input.notes?.trim() || null,
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.sellerUserId,
      actorType: "USER",
      action: "grading.authentication_requested",
      subjectType: "GradingSubmission",
      subjectId: submission.id,
      after: { listingId: listing.id, askingPriceCents: listing.askingPriceCents },
      ipHash: ctx.ipHash,
    });
    return { ok: true, submissionId: submission.id } as const;
  });
}

export type AssignResult =
  | { ok: true; submissionId: string }
  | { ok: false; reason: "OWNER_ONLY" | "NOT_FOUND" | "NOT_OPEN" | "ALREADY_REQUESTED" | "ALREADY_AUTHENTICATED" | AssignFailure | Ineligible };

/**
 * The owner sends a piece to a partner: either a seller's request, or a
 * high-value listing the owner picks directly. The seller is emailed.
 */
export async function assignAuthentication(
  deps: GradingDeps,
  input: { actorId: string; authenticatorId: string; submissionId?: string; listingId?: string; notes?: string | null },
  ctx: RequestContext = {},
): Promise<AssignResult> {
  const result = await deps.db.$transaction(async (tx) => {
    if (!(await isOwner(tx, input.actorId))) return { ok: false, reason: "OWNER_ONLY" } as const;
    let submissionId = input.submissionId;
    if (submissionId) {
      const submission = await tx.gradingSubmission.findUnique({ where: { id: submissionId } });
      if (!submission) return { ok: false, reason: "NOT_FOUND" } as const;
      if (submission.status !== "SUBMITTED") return { ok: false, reason: "NOT_OPEN" } as const;
      const failure = await checkAuthenticator(tx, input.authenticatorId, submission.categoryId);
      if (failure) return { ok: false, reason: failure } as const;
      const moved = await tx.gradingSubmission.updateMany({
        where: { id: submission.id, status: "SUBMITTED" },
        data: { status: "IN_REVIEW", assignedAuthenticatorId: input.authenticatorId },
      });
      if (moved.count !== 1) return { ok: false, reason: "NOT_OPEN" } as const;
    } else {
      const listing = await tx.listing.findUnique({ where: { id: input.listingId ?? "" }, include: { category: { select: { vertical: true } } } });
      if (!listing) return { ok: false, reason: "NOT_FOUND" } as const;
      const ineligible = authenticationEligibility(listing, config(deps));
      if (ineligible) return { ok: false, reason: ineligible } as const;
      const existing = await openOrPublished(tx, listing.id);
      if (existing) return { ok: false, reason: existing } as const;
      const failure = await checkAuthenticator(tx, input.authenticatorId, listing.categoryId);
      if (failure) return { ok: false, reason: failure } as const;
      const created = await tx.gradingSubmission.create({
        data: {
          listingId: listing.id,
          ownerUserId: listing.sellerUserId,
          categoryId: listing.categoryId,
          requestedTier: "AUTHENTICATED",
          feeCents: 0,
          status: "IN_REVIEW",
          assignedAuthenticatorId: input.authenticatorId,
          notes: input.notes?.trim() || null,
        },
      });
      submissionId = created.id;
    }
    const submission = await tx.gradingSubmission.findUniqueOrThrow({
      where: { id: submissionId },
      include: { owner: { select: { email: true } }, listing: { select: { id: true, title: true } }, assignedAuthenticator: true },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "grading.authentication_assigned",
      subjectType: "GradingSubmission",
      subjectId: submission.id,
      after: { listingId: submission.listingId, authenticatorId: input.authenticatorId, ownerInitiated: !input.submissionId },
      ipHash: ctx.ipHash,
    });
    return {
      ok: true,
      submissionId: submission.id,
      email: submission.owner.email,
      title: submission.listing?.title ?? "your item",
      partner: submission.assignedAuthenticator!.organization ?? submission.assignedAuthenticator!.name,
    } as const;
  });
  if (!result.ok) return result;
  await deps.mailer.send({
    to: result.email,
    subject: "Your listing is with a partner authenticator",
    text: `We sent "${result.title}" to ${result.partner}, one of our partner authenticators. They work from your listing photos and description and may ask us for more detail. There is no charge during the beta.\n\nYou'll get an email when they finish. Your listing stays live in the meantime.`,
  });
  return { ok: true, submissionId: result.submissionId };
}

// ───────────── Results ─────────────

export type AuthenticationOutcome = "AUTHENTICATED" | "NOT_AUTHENTICATED" | "INCONCLUSIVE";

export type RecordResultResult =
  | { ok: true; certificateNumber: string | null }
  | { ok: false; reason: "OWNER_ONLY" | "NOT_FOUND" | "NOT_IN_REVIEW" | "NOTES_REQUIRED" };

const OUTCOME_EMAIL: Record<AuthenticationOutcome, (title: string, cert: string | null) => { subject: string; text: string }> = {
  AUTHENTICATED: (title, cert) => ({
    subject: "Your listing was authenticated",
    text: `A partner authenticator reviewed "${title}" and authenticated it. Your listing now shows an "Authenticated by partner" badge with certificate ${cert}.`,
  }),
  NOT_AUTHENTICATED: (title) => ({
    subject: "Partner authentication result",
    text: `A partner authenticator reviewed "${title}" and could not authenticate it. Their notes are below. Your listing has no authentication badge; our team may follow up about the description.`,
  }),
  INCONCLUSIVE: (title) => ({
    subject: "Partner authentication result",
    text: `A partner authenticator reviewed "${title}" but couldn't reach a conclusion from what's available. Their notes are below. You can ask again later with more photos or documentation.`,
  }),
};

/**
 * The owner records the partner's finding. AUTHENTICATED publishes a result
 * (with a certificate number) that shows as a listing badge. NOT_AUTHENTICATED
 * keeps an internal REJECTED result. INCONCLUSIVE returns the request with no result.
 */
export async function recordAuthenticationResult(
  deps: GradingDeps,
  input: { actorId: string; submissionId: string; outcome: AuthenticationOutcome; notes: string },
  ctx: RequestContext = {},
): Promise<RecordResultResult> {
  const notes = input.notes.trim();
  if (notes.length < 5) return { ok: false, reason: "NOTES_REQUIRED" };
  const now = clock(deps);
  const result = await deps.db.$transaction(async (tx) => {
    if (!(await isOwner(tx, input.actorId))) return { ok: false, reason: "OWNER_ONLY" } as const;
    const submission = await tx.gradingSubmission.findUnique({
      where: { id: input.submissionId },
      include: { owner: { select: { email: true } }, listing: { select: { title: true } } },
    });
    if (!submission) return { ok: false, reason: "NOT_FOUND" } as const;
    if (submission.status !== "IN_REVIEW" || !submission.assignedAuthenticatorId) return { ok: false, reason: "NOT_IN_REVIEW" } as const;
    const nextStatus = input.outcome === "AUTHENTICATED" ? "COMPLETED" : input.outcome === "NOT_AUTHENTICATED" ? "REJECTED" : "RETURNED";
    const moved = await tx.gradingSubmission.updateMany({ where: { id: submission.id, status: "IN_REVIEW" }, data: { status: nextStatus } });
    if (moved.count !== 1) return { ok: false, reason: "NOT_IN_REVIEW" } as const;
    let certificateNumber: string | null = null;
    let resultId: string | null = null;
    if (input.outcome !== "INCONCLUSIVE") {
      const authenticated = input.outcome === "AUTHENTICATED";
      const number = generateCertificateNumber();
      certificateNumber = authenticated ? number : null;
      const created = await tx.gradingResult.create({
        data: {
          submissionId: submission.id,
          tierAwarded: "AUTHENTICATED",
          notes,
          certificateNumber: number,
          gradedByAuthenticatorId: submission.assignedAuthenticatorId,
          recordedById: input.actorId,
          status: authenticated ? "PUBLISHED" : "REJECTED",
          publishedAt: authenticated ? now : null,
        },
      });
      resultId = created.id;
    }
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "grading.authentication_recorded",
      subjectType: "GradingSubmission",
      subjectId: submission.id,
      after: { outcome: input.outcome, resultId, certificateNumber, authenticatorId: submission.assignedAuthenticatorId, listingId: submission.listingId },
      ipHash: ctx.ipHash,
    });
    return { ok: true, certificateNumber, email: submission.owner.email, title: submission.listing?.title ?? "your item" } as const;
  });
  if (!result.ok) return result;
  const mail = OUTCOME_EMAIL[input.outcome](result.title, result.certificateNumber);
  await deps.mailer.send({ to: result.email, subject: mail.subject, text: input.outcome === "AUTHENTICATED" ? mail.text : `${mail.text}\n\n${notes}` });
  return { ok: true, certificateNumber: result.certificateNumber };
}

export type RevokeResult = { ok: true } | { ok: false; reason: "OWNER_ONLY" | "NOT_FOUND" | "NOT_PUBLISHED" | "REASON_REQUIRED" };

/** Takes a published authentication down (new information, a partner retracting). The seller is emailed. */
export async function revokeAuthentication(
  deps: GradingDeps,
  input: { actorId: string; resultId: string; reason: string },
  ctx: RequestContext = {},
): Promise<RevokeResult> {
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, reason: "REASON_REQUIRED" };
  const result = await deps.db.$transaction(async (tx) => {
    if (!(await isOwner(tx, input.actorId))) return { ok: false, reason: "OWNER_ONLY" } as const;
    const current = await tx.gradingResult.findUnique({
      where: { id: input.resultId },
      include: { submission: { include: { owner: { select: { email: true } }, listing: { select: { title: true } } } } },
    });
    if (!current) return { ok: false, reason: "NOT_FOUND" } as const;
    const updated = await tx.gradingResult.updateMany({
      where: { id: current.id, status: "PUBLISHED" },
      data: { status: "REVOKED", revokedAt: clock(deps), revokeReason: reason },
    });
    if (updated.count !== 1) return { ok: false, reason: "NOT_PUBLISHED" } as const;
    await writeAuditEvent(tx, {
      actorUserId: input.actorId,
      actorType: "ADMIN",
      action: "grading.authentication_revoked",
      subjectType: "GradingResult",
      subjectId: current.id,
      before: { status: "PUBLISHED", certificateNumber: current.certificateNumber },
      after: { status: "REVOKED", reason },
      ipHash: ctx.ipHash,
    });
    return { ok: true, email: current.submission.owner.email, title: current.submission.listing?.title ?? "your item", cert: current.certificateNumber } as const;
  });
  if (!result.ok) return result;
  await deps.mailer.send({
    to: result.email,
    subject: "An authentication badge was removed",
    text: `We removed the authentication badge (certificate ${result.cert}) from "${result.title}":\n\n${reason}\n\nReply to this email if you have questions.`,
  });
  return { ok: true };
}

// ───────────── Reads ─────────────

export type PublicAuthentication = { certificateNumber: string; partner: string; publishedAt: Date };

/** The published partner authentication shown on a listing, if any. */
export async function listingAuthentication(db: Db, listingId: string): Promise<PublicAuthentication | null> {
  const result = await db.gradingResult.findFirst({
    where: { status: "PUBLISHED", tierAwarded: "AUTHENTICATED", submission: { listingId } },
    orderBy: { publishedAt: "desc" },
    include: { gradedByAuthenticator: { select: { name: true, organization: true } } },
  });
  if (!result?.publishedAt) return null;
  const partner = result.gradedByAuthenticator?.organization ?? result.gradedByAuthenticator?.name ?? "Partner authenticator";
  return { certificateNumber: result.certificateNumber, partner, publishedAt: result.publishedAt };
}

/** Listing ids among these that carry a published authentication (for browse cards). */
export async function authenticatedListingIds(db: Db, listingIds: string[]): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set();
  const rows = await db.gradingSubmission.findMany({
    where: { listingId: { in: listingIds }, results: { some: { status: "PUBLISHED", tierAwarded: "AUTHENTICATED" } } },
    select: { listingId: true },
  });
  return new Set(rows.map((r) => r.listingId!).filter(Boolean));
}
