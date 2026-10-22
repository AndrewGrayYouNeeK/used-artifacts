"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/app/actions/auth";
import { decideListingReview } from "@/domains/compliance/review";
import { StorefrontSchema, createStorefront, submitListing } from "@/domains/listings/listings";
import { changeAskingPrice, withdrawListing } from "@/domains/listings/manage";
import { MAX_PHOTOS, processPhoto, storePhotos } from "@/domains/listings/photos";
import { parseAcceptedSuggestions, suggestFromPhotos } from "@/domains/ai/analyzer";
import type { NormalizedAnalysis } from "@/domains/ai/output";
import type { AiUncertainty } from "@/generated/prisma/enums";
import { checkIdentityGate } from "@/domains/identity/verification/verification";
import { visionProvider } from "@/lib/ai/vision-provider";
import { AskingPriceSchema, ListingSubmissionSchema } from "@/domains/listings/rules";
import { requireStaff, requireUser } from "@/lib/auth/dal";
import { requestContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage/storage";

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

const gateMessage = {
  NOT_VERIFIED: "Verify your identity before selling.",
  UNDER_REVIEW: "Your identity verification is being reviewed. You can sell once it's approved.",
  BLOCKED: "This account can't sell. Contact support.",
  AUCTIONS_DISABLED: "Auctions aren't available yet.",
} as const;

export async function createStorefrontAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = StorefrontSchema.safeParse({ name: str(formData, "name"), slug: str(formData, "slug") });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Please fix the highlighted fields.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }
  const result = await createStorefront({ db }, { userId: user.id, ...parsed.data }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "SLUG_TAKEN":
        return { status: "error", message: "That store address is taken.", fieldErrors: { slug: ["Already taken."] } };
      case "ALREADY_HAS_STOREFRONT":
        redirect("/sell");
      case "NOT_VERIFIED":
      case "UNDER_REVIEW":
      case "BLOCKED":
      case "AUCTIONS_DISABLED":
        return { status: "error", message: gateMessage[result.reason] };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled storefront failure: ${String(exhaustive)}`);
      }
    }
  }
  redirect("/sell");
}

export async function submitListingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const isAuction = str(formData, "format") === "AUCTION";
  const optional = (key: string) => str(formData, key).trim() || undefined;
  const parsed = ListingSubmissionSchema.safeParse({
    categoryId: str(formData, "categoryId"),
    title: str(formData, "title"),
    description: str(formData, "description"),
    format: isAuction ? "AUCTION" : "FIXED",
    askingPrice: isAuction ? undefined : str(formData, "askingPrice"),
    startingBid: isAuction ? str(formData, "startingBid") : undefined,
    reservePrice: isAuction ? optional("reservePrice") : undefined,
    durationDays: isAuction ? Number(str(formData, "durationDays")) : undefined,
    shipping: str(formData, "shipping"),
    sellerConditionGrade: str(formData, "sellerConditionGrade"),
    regionOfOrigin: str(formData, "regionOfOrigin"),
    estimatedAge: str(formData, "estimatedAge"),
    materials: str(formData, "materials"),
    acquisitionSource: str(formData, "acquisitionSource"),
    acquisitionState: str(formData, "acquisitionState"),
    acquisitionYearApprox: str(formData, "acquisitionYearApprox"),
    acquisitionDetails: str(formData, "acquisitionDetails"),
    landownerName: str(formData, "landownerName"),
    attestationKeys: formData.getAll("attestation").map(String),
    iacaAcknowledged: formData.get("iacaAcknowledged") === "on",
    signedName: str(formData, "signedName"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Please fix the highlighted fields.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }

  const files = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return { status: "error", message: "Add at least one photo.", fieldErrors: { photos: ["Add at least one photo."] } };
  }
  if (files.length > MAX_PHOTOS) {
    return { status: "error", message: `Up to ${MAX_PHOTOS} photos.`, fieldErrors: { photos: [`Up to ${MAX_PHOTOS} photos.`] } };
  }
  const stored = await storePhotos(storage(), await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer()))));
  if (!stored.ok) {
    const message =
      stored.reason === "TOO_LARGE"
        ? `Photo ${stored.index + 1} is larger than 5 MB.`
        : stored.reason === "NOT_AN_IMAGE"
          ? `Photo ${stored.index + 1} isn't a JPEG, PNG, WebP, or HEIC image.`
          : `Up to ${MAX_PHOTOS} photos.`;
    return { status: "error", message, fieldErrors: { photos: [message] } };
  }

  const result = await submitListing(
    { db, vision: visionProvider() },
    {
      userId: user.id,
      submission: parsed.data,
      photos: stored.photos,
      aiSuggestionId: str(formData, "aiAnalysisId") || null,
      aiAccepted: parseAcceptedSuggestions(formData.getAll("aiAccepted").map(String)),
    },
    await requestContext(),
  );
  if (result.ok) redirect(`/sell?submitted=${encodeURIComponent(result.listingId)}`);
  await Promise.all(stored.photos.map((p) => storage().delete(p.storageKey).catch(() => undefined)));
  switch (result.reason) {
    case "INVALID": {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of result.issues) (fieldErrors[issue.field] ??= []).push(issue.message);
      return { status: "error", message: "Please fix the highlighted fields.", fieldErrors };
    }
    case "PROHIBITED": {
      const reasons = [...new Set(result.matches.map((m) => `${m.reason} (“${m.matchedText}”)`))];
      return {
        status: "error",
        message: `This listing can't be posted. ${reasons.join("; ")}. Items like this are banned on Used Artifacts.`,
      };
    }
    case "NO_STOREFRONT":
      return { status: "error", message: "Create your storefront first." };
    case "PHOTOS_REQUIRED":
      return { status: "error", message: `Add 1 to ${MAX_PHOTOS} photos.`, fieldErrors: { photos: ["Add at least one photo."] } };
    case "CATEGORY_UNAVAILABLE":
      return { status: "error", message: "That category isn't open for listings.", fieldErrors: { categoryId: ["Choose another category."] } };
    case "NOT_VERIFIED":
    case "UNDER_REVIEW":
    case "BLOCKED":
    case "AUCTIONS_DISABLED":
      return { status: "error", message: gateMessage[result.reason] };
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled listing failure: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export async function decideListingReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const decision = str(formData, "decision");
  if (decision !== "APPROVE" && decision !== "REJECT") return { status: "error", message: "Choose a decision." };
  const result = await decideListingReview(
    { db },
    { reviewerId: staff.id, reviewId: str(formData, "reviewId"), decision, notes: str(formData, "notes") },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "NOTES_REQUIRED":
        return { status: "error", message: "Explain the rejection so the seller knows what to fix." };
      case "SELF_REVIEW":
        return { status: "error", message: "You can't review your own listing. Another staff member must." };
      case "SELLER_NOT_VERIFIED":
        return { status: "error", message: "The seller's identity is no longer verified." };
      case "AI_FLAG_NOTES_REQUIRED":
        return {
          status: "error",
          message: "The photo analyzer raised a red flag. Explain in the notes (20+ characters) why this item is allowed.",
        };
      case "AUCTIONS_DISABLED":
        return { status: "error", message: "Auctions are switched off, so this auction listing can't go live. Reject it so the seller can relist at a fixed price." };
      case "NOT_STAFF":
      case "NOT_FOUND":
      case "ALREADY_DECIDED":
        return { status: "error", message: "This review is no longer open." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled review failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/compliance");
  return { status: "success", message: result.listingStatus === "LIVE" ? "Approved and live." : "Rejected." };
}

export async function changePriceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const price = AskingPriceSchema.safeParse(str(formData, "askingPrice"));
  if (!price.success) return { status: "error", message: price.error.issues[0]?.message ?? "Enter a valid price." };
  const result = await changeAskingPrice(
    { db },
    { sellerUserId: user.id, listingId: str(formData, "listingId"), askingPriceCents: price.data },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "UNCHANGED":
        return { status: "error", message: "That's already the price." };
      case "INVALID_PRICE":
        return { status: "error", message: "Asking price must be between $1 and $1,000,000." };
      case "NOT_FOUND":
      case "NOT_EDITABLE":
        return { status: "error", message: "This listing's price can't be changed now." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled price change failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/sell");
  return { status: "success", message: "Price updated." };
}

export async function withdrawListingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const result = await withdrawListing({ db }, { sellerUserId: user.id, listingId: str(formData, "listingId") }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "NOT_FOUND":
      case "NOT_WITHDRAWABLE":
        return { status: "error", message: "This listing can't be withdrawn (it may have a pending or paid order)." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled withdraw failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/sell");
  return { status: "success", message: "Listing withdrawn." };
}

export type SuggestState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      analysisId: string;
      uncertainty: AiUncertainty;
      flags: string[];
      normalized: NormalizedAnalysis;
      unavailable: boolean;
    };

/** Pre-submission photo analysis; the seller chooses which suggestions to copy into the form. */
export async function suggestFromPhotosAction(_prev: SuggestState, formData: FormData): Promise<SuggestState> {
  const user = await requireUser();
  const gate = await checkIdentityGate(db, user.id, "SELL");
  if (!gate.ok) return { status: "error", message: gateMessage[gate.reason] };
  const files = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { status: "error", message: "Add photos first." };
  if (files.length > MAX_PHOTOS) return { status: "error", message: `Up to ${MAX_PHOTOS} photos.` };
  const photos = [];
  for (const [index, file] of files.entries()) {
    const processed = await processPhoto(new Uint8Array(await file.arrayBuffer()));
    if (!processed.ok) {
      return {
        status: "error",
        message: processed.reason === "TOO_LARGE" ? `Photo ${index + 1} is larger than 5 MB.` : `Photo ${index + 1} isn't a supported image.`,
      };
    }
    photos.push({ bytes: processed.webp, pHash: processed.pHash });
  }
  const result = await suggestFromPhotos(
    { db, vision: visionProvider() },
    { userId: user.id, photos, categoryId: str(formData, "categoryId") || null },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "RATE_LIMITED":
        return { status: "error", message: "You've used today's photo analyses. Try again tomorrow, or submit without suggestions." };
      case "NO_PHOTOS":
        return { status: "error", message: "Add photos first." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled suggestion failure: ${String(exhaustive)}`);
      }
    }
  }
  const a = result.analysis;
  return {
    status: "ready",
    analysisId: a.id,
    uncertainty: a.uncertainty,
    flags: a.flags,
    normalized: a.normalized,
    unavailable: a.error !== null,
  };
}
