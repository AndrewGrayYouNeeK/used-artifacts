"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions/auth";
import type { AuthenticatorStatus } from "@/generated/prisma/enums";
import {
  assignAuthentication,
  createAuthenticator,
  recordAuthenticationResult,
  requestAuthentication,
  revokeAuthentication,
  updateAuthenticator,
  type AuthenticationOutcome,
  type Ineligible,
} from "@/domains/grading/authentication";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { requestContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { identityDeps } from "@/lib/identity-deps";

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

const INELIGIBLE: Record<Ineligible, string> = {
  NOT_LIVE: "Only live listings can be authenticated.",
  NOT_FIXED_PRICE: "Partner authentication is for fixed-price listings during the beta.",
  BELOW_THRESHOLD: "Partner authentication is for high-value pieces only.",
  VERTICAL_CLOSED: "This category isn't open yet.",
};

const fail = (message: string): FormState => ({ status: "error", message });

export async function requestAuthenticationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const result = await requestAuthentication({ db }, { sellerUserId: user.id, listingId: str(formData, "listingId"), notes: str(formData, "notes") }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "NOT_FOUND":
        return fail("That listing isn't available.");
      case "ALREADY_REQUESTED":
        return fail("Authentication is already requested for this listing.");
      case "ALREADY_AUTHENTICATED":
        return fail("This listing is already authenticated.");
      case "NOT_LIVE":
      case "NOT_FIXED_PRICE":
      case "BELOW_THRESHOLD":
      case "VERTICAL_CLOSED":
        return fail(INELIGIBLE[result.reason]);
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled authentication request failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/sell");
  return { status: "success", message: "Requested. We'll email you when a partner takes it on." };
}

export async function addAuthenticatorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const owner = await requireOwner();
  const result = await createAuthenticator(
    { db },
    {
      actorId: owner.id,
      name: str(formData, "name"),
      organization: str(formData, "organization"),
      credentials: str(formData, "credentials"),
      specialtyCategoryIds: formData.getAll("specialtyCategoryIds").map(String).filter(Boolean),
      agreementSigned: formData.get("agreementSigned") === "on",
    },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "DETAILS_REQUIRED":
        return fail("Add a name and their credentials.");
      case "UNKNOWN_CATEGORY":
        return fail("Pick specialties from the list.");
      case "OWNER_ONLY":
        return fail("Only the owner can add partners.");
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled authenticator failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/grading");
  return { status: "success", message: "Partner added." };
}

const STATUSES: readonly AuthenticatorStatus[] = ["ACTIVE", "PAUSED", "TERMINATED"];

export async function updateAuthenticatorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const owner = await requireOwner();
  const status = str(formData, "status");
  const result = await updateAuthenticator(
    { db },
    {
      actorId: owner.id,
      authenticatorId: str(formData, "authenticatorId"),
      status: STATUSES.includes(status as AuthenticatorStatus) ? (status as AuthenticatorStatus) : undefined,
      agreementSigned: formData.get("agreementSigned") === "on" ? true : undefined,
    },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "TERMINATED":
        return fail("This partnership has ended; add them again if it restarts.");
      case "OWNER_ONLY":
      case "NOT_FOUND":
        return fail("That partner isn't available.");
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled authenticator update failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/grading");
  return { status: "success", message: "Saved." };
}

export async function assignAuthenticationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const owner = await requireOwner();
  const submissionId = str(formData, "submissionId") || undefined;
  const listingId = str(formData, "listingId") || undefined;
  const result = await assignAuthentication(
    identityDeps(),
    { actorId: owner.id, authenticatorId: str(formData, "authenticatorId"), submissionId, listingId, notes: str(formData, "notes") },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "AUTHENTICATOR_UNAVAILABLE":
        return fail("Pick an active partner.");
      case "NO_AGREEMENT":
        return fail("Record the partner's signed agreement first.");
      case "OUTSIDE_SPECIALTY":
        return fail("That partner doesn't cover this category.");
      case "NOT_OPEN":
        return fail("This request was already assigned.");
      case "ALREADY_REQUESTED":
        return fail("This listing already has an open request.");
      case "ALREADY_AUTHENTICATED":
        return fail("This listing is already authenticated.");
      case "NOT_LIVE":
      case "NOT_FIXED_PRICE":
      case "BELOW_THRESHOLD":
      case "VERTICAL_CLOSED":
        return fail(INELIGIBLE[result.reason]);
      case "OWNER_ONLY":
      case "NOT_FOUND":
        return fail("That request isn't available.");
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled assignment failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/grading");
  return { status: "success", message: "Assigned; the seller was emailed." };
}

const OUTCOMES: readonly AuthenticationOutcome[] = ["AUTHENTICATED", "NOT_AUTHENTICATED", "INCONCLUSIVE"];

export async function recordAuthenticationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const owner = await requireOwner();
  const outcome = str(formData, "outcome") as AuthenticationOutcome;
  if (!OUTCOMES.includes(outcome)) return fail("Choose the partner's finding.");
  const result = await recordAuthenticationResult(
    identityDeps(),
    { actorId: owner.id, submissionId: str(formData, "submissionId"), outcome, notes: str(formData, "notes") },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "NOTES_REQUIRED":
        return fail("Record the partner's notes.");
      case "NOT_IN_REVIEW":
        return fail("This request isn't with a partner.");
      case "OWNER_ONLY":
      case "NOT_FOUND":
        return fail("That request isn't available.");
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled result failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/grading");
  return { status: "success", message: result.certificateNumber ? `Published: certificate ${result.certificateNumber}.` : "Recorded and emailed." };
}

export async function revokeAuthenticationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const owner = await requireOwner();
  const result = await revokeAuthentication(identityDeps(), { actorId: owner.id, resultId: str(formData, "resultId"), reason: str(formData, "reason") }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "REASON_REQUIRED":
        return fail("Give a reason (it's emailed to the seller).");
      case "NOT_PUBLISHED":
        return fail("Already revoked.");
      case "OWNER_ONLY":
      case "NOT_FOUND":
        return fail("That result isn't available.");
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled revoke failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/grading");
  return { status: "success", message: "Badge removed; the seller was emailed." };
}
