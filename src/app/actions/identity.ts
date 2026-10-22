"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/app/actions/auth";
import { FakeIdentityProvider } from "@/domains/identity/verification/fake-provider";
import {
  processVerificationEvent,
  reviewIdentity,
  startVerification,
} from "@/domains/identity/verification/verification";
import { serverEnv } from "@/config/env";
import { requireStaff, requireUser } from "@/lib/auth/dal";
import { requestContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { usingFakeIdentityProvider, verificationDeps } from "@/lib/identity/verification-deps";

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

export async function startVerificationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const result = await startVerification(
    verificationDeps(),
    { userId: user.id, consent: formData.get("consent") === "on" },
    await requestContext(),
  );
  if (result.ok) redirect(result.url);
  switch (result.reason) {
    case "CONSENT_REQUIRED":
      return { status: "error", message: "Please read and accept the notice to continue." };
    case "ALREADY_VERIFIED":
      return { status: "success", message: "Your identity is already verified." };
    case "UNDER_REVIEW":
      return { status: "error", message: "Your verification is being reviewed by our team. We'll email you." };
    case "BLOCKED":
      return {
        status: "error",
        message: "This ID can't be used for this account. Each person may have only one account. Contact support.",
      };
    case "TOO_MANY_ATTEMPTS":
      return { status: "error", message: "Too many verification attempts. Contact support to try again." };
    default: {
      const exhaustive: never = result.reason;
      throw new Error(`Unhandled verification failure: ${String(exhaustive)}`);
    }
  }
}

const DevDocumentSchema = z.object({
  session: z.string().min(1),
  outcome: z.enum(["VERIFIED", "REQUIRES_INPUT", "CANCELED"]),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  dob: z.iso.date(),
  documentNumber: z.string().trim().min(3),
  issuingCountry: z.string().trim().length(2),
});

/** Dev only: stands in for Stripe's hosted flow and webhook when IDENTITY_PROVIDER=fake. */
export async function devCompleteVerificationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!usingFakeIdentityProvider()) return { status: "error", message: "Not available." };
  const user = await requireUser();
  const parsed = DevDocumentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: "error", message: "Fill in every field." };
  const input = parsed.data;
  const record = await db.identityVerification.findUnique({ where: { userId: user.id } });
  if (!record || record.providerSessionId !== input.session) {
    return { status: "error", message: "That verification session isn't yours or has been replaced." };
  }
  const provider = new FakeIdentityProvider(serverEnv().APP_URL);
  const [year, month, day] = input.dob.split("-").map(Number);
  provider.setDocument(input.session, {
    firstName: input.firstName,
    lastName: input.lastName,
    dob: { year, month, day },
    documentNumber: input.documentNumber,
    documentType: "driving_license",
    issuingCountry: input.issuingCountry.toUpperCase(),
  });
  await processVerificationEvent(verificationDeps(provider), {
    eventId: `fake_evt_${crypto.randomUUID()}`,
    kind: input.outcome,
    sessionId: input.session,
    errorCode: input.outcome === "REQUIRES_INPUT" ? "document_unverified_other" : null,
  });
  redirect("/account/verify/return");
}

export async function reviewIdentityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const decision = str(formData, "decision");
  if (decision !== "APPROVE" && decision !== "REJECT") return { status: "error", message: "Choose a decision." };
  const result = await reviewIdentity(
    { db },
    { reviewerId: staff.id, verificationId: str(formData, "verificationId"), decision, notes: str(formData, "notes") },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "NOTES_REQUIRED":
        return { status: "error", message: "Write a short note explaining the decision." };
      case "SELF_REVIEW":
        return { status: "error", message: "You can't review your own verification." };
      case "NOT_FOUND":
      case "NOT_IN_REVIEW":
        return { status: "error", message: "This verification is no longer waiting for review." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled review failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/compliance");
  return { status: "success", message: result.status === "VERIFIED" ? "Approved." : "Rejected." };
}
