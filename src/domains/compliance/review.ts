import type { Db } from "@/lib/db";
import { writeAuditEvent } from "@/domains/audit/audit";
import { awardBetaFounder } from "@/domains/growth/badges";
import type { RequestContext } from "@/domains/identity/accounts";

export type ReviewDecision = "APPROVE" | "REJECT";

export type DecideListingResult =
  | { ok: true; listingStatus: "LIVE" | "REJECTED" }
  | {
      ok: false;
      reason: "NOT_STAFF" | "NOT_FOUND" | "ALREADY_DECIDED" | "SELF_REVIEW" | "NOTES_REQUIRED" | "SELLER_NOT_VERIFIED" | "AI_FLAG_NOTES_REQUIRED";
    };

/** Approving over an AI red flag (possible remains, funerary, sacred, patrimony) needs a written reason. */
export const AI_FLAG_APPROVAL_NOTES_MIN = 20;

/**
 * Staff decision on a queued listing. A seller can never approve their own
 * listing, and the database refuses to make a listing LIVE without a signed
 * statement from a verified seller.
 */
export async function decideListingReview(
  deps: { db: Db; now?: () => Date },
  input: { reviewerId: string; reviewId: string; decision: ReviewDecision; notes: string },
  ctx: RequestContext = {},
): Promise<DecideListingResult> {
  const notes = input.notes.trim();
  if (input.decision === "REJECT" && notes.length < 5) return { ok: false, reason: "NOTES_REQUIRED" };
  const now = deps.now ? deps.now() : new Date();

  return deps.db.$transaction(async (tx) => {
    const reviewer = await tx.user.findUnique({ where: { id: input.reviewerId }, select: { role: true } });
    if (!reviewer || (reviewer.role !== "OWNER" && reviewer.role !== "MODERATOR")) {
      return { ok: false, reason: "NOT_STAFF" } as const;
    }
    const review = await tx.complianceReview.findUnique({
      where: { id: input.reviewId },
      include: { listing: { select: { id: true, sellerUserId: true, status: true } } },
    });
    if (!review) return { ok: false, reason: "NOT_FOUND" } as const;
    if (review.status !== "OPEN" || review.listing.status !== "PENDING_REVIEW") {
      return { ok: false, reason: "ALREADY_DECIDED" } as const;
    }
    if (review.listing.sellerUserId === input.reviewerId) return { ok: false, reason: "SELF_REVIEW" } as const;

    const approve = input.decision === "APPROVE";
    if (approve) {
      const verified = await tx.identityVerification.findFirst({
        where: { userId: review.listing.sellerUserId, status: "VERIFIED" },
        select: { id: true },
      });
      if (!verified) return { ok: false, reason: "SELLER_NOT_VERIFIED" } as const;
      const redFlagged = await tx.aiAnalysis.findFirst({
        where: { listingId: review.listing.id, blocksPublishing: true },
        select: { id: true },
      });
      if (redFlagged && notes.length < AI_FLAG_APPROVAL_NOTES_MIN) {
        return { ok: false, reason: "AI_FLAG_NOTES_REQUIRED" } as const;
      }
    }

    const claimed = await tx.complianceReview.updateMany({
      where: { id: review.id, status: "OPEN" },
      data: {
        status: approve ? "APPROVED" : "REJECTED",
        reviewerId: input.reviewerId,
        decision: input.decision,
        notes: notes || null,
        decidedAt: now,
      },
    });
    if (claimed.count !== 1) return { ok: false, reason: "ALREADY_DECIDED" } as const;

    const listingStatus = approve ? "LIVE" : "REJECTED";
    await tx.listing.update({
      where: { id: review.listing.id },
      data: { status: listingStatus, publishedAt: approve ? now : null },
    });
    if (approve) await awardBetaFounder(tx, review.listing.sellerUserId, { now });
    await writeAuditEvent(tx, {
      actorUserId: input.reviewerId,
      actorType: "ADMIN",
      action: approve ? "compliance.listing_approved" : "compliance.listing_rejected",
      subjectType: "ComplianceReview",
      subjectId: review.id,
      before: { listingStatus: review.listing.status },
      after: { listingId: review.listing.id, listingStatus, notes: notes || null },
      ipHash: ctx.ipHash,
    });
    return { ok: true, listingStatus } as const;
  });
}
