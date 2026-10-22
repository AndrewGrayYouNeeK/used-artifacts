"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/app/actions/auth";
import { decideListingReview } from "@/domains/compliance/review";
import { StorefrontSchema, createStorefront, submitListing } from "@/domains/listings/listings";
import { ListingSubmissionSchema } from "@/domains/listings/rules";
import { requireStaff, requireUser } from "@/lib/auth/dal";
import { requestContext } from "@/lib/auth/session";
import { db } from "@/lib/db";

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
  const parsed = ListingSubmissionSchema.safeParse({
    categoryId: str(formData, "categoryId"),
    title: str(formData, "title"),
    description: str(formData, "description"),
    askingPrice: str(formData, "askingPrice"),
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

  const result = await submitListing({ db }, { userId: user.id, submission: parsed.data }, await requestContext());
  if (result.ok) redirect(`/sell?submitted=${encodeURIComponent(result.listingId)}`);
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
