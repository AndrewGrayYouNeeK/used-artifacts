"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions/auth";
import { serverEnv } from "@/config/env";
import { recordDailyReview } from "@/domains/admin/daily-review";
import { handleFeedback, submitFeedback } from "@/domains/admin/feedback";
import { setKillSwitch } from "@/domains/admin/kill-switches";
import { createBetaInvite, revokeBetaInvite } from "@/domains/growth/beta-invites";
import { FeedbackCategory, FeedbackStatus, KillSwitchKey } from "@/generated/prisma/enums";
import { requireOwner, requireStaff, requireUser } from "@/lib/auth/dal";
import { requestContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getMailer } from "@/lib/email/mailer";

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");
const isEnumValue = <T extends string>(values: Record<string, T>, v: string): v is T => (Object.values(values) as string[]).includes(v);

export async function setKillSwitchAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const key = str(formData, "key");
  if (!isEnumValue(KillSwitchKey, key)) return { status: "error", message: "Unknown switch." };
  const paused = str(formData, "paused") === "true";
  const result = await setKillSwitch({ db }, { actorId: staff.id, key, paused, reason: str(formData, "reason") }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "REASON_REQUIRED":
        return { status: "error", message: "Say why (at least 5 characters). It goes in the audit log." };
      case "OWNER_ONLY":
        return { status: "error", message: "Only the owner can resume a paused switch." };
      case "UNCHANGED":
        return { status: "error", message: paused ? "Already paused." : "Already running." };
      case "NOT_STAFF":
        return { status: "error", message: "That action isn't available." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled kill switch failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { status: "success", message: paused ? "Paused." : "Resumed." };
}

export type InviteFormState = FormState | { status: "created"; code: string; link: string; emailed: boolean };

export async function createInviteAction(_prev: InviteFormState, formData: FormData): Promise<InviteFormState> {
  const owner = await requireOwner();
  const days = str(formData, "expiresInDays");
  const result = await createBetaInvite(
    { db, appUrl: serverEnv().APP_URL, mailer: getMailer() },
    {
      actorId: owner.id,
      note: str(formData, "note"),
      email: str(formData, "email") || null,
      maxUses: Number(str(formData, "maxUses") || "1"),
      expiresInDays: days ? Number(days) : null,
      sendEmail: str(formData, "sendEmail") === "on",
    },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "NOTE_REQUIRED":
        return { status: "error", message: "Add a note on who this invite is for." };
      case "INVALID_USES":
        return { status: "error", message: "Uses must be between 1 and 1000." };
      case "INVALID_EXPIRY":
        return { status: "error", message: "Expiry must be between 1 and 365 days, or blank for none." };
      case "INVALID_EMAIL":
        return { status: "error", message: "That email address doesn't look right." };
      case "OWNER_ONLY":
        return { status: "error", message: "Only the owner issues invites." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled invite failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/beta");
  return { status: "created", code: result.code, link: result.link, emailed: result.emailed };
}

export async function revokeInviteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const owner = await requireOwner();
  const result = await revokeBetaInvite({ db }, { actorId: owner.id, inviteId: str(formData, "inviteId") }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "ALREADY_REVOKED":
        return { status: "error", message: "Already revoked." };
      case "NOT_FOUND":
      case "OWNER_ONLY":
        return { status: "error", message: "That invite isn't available." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled revoke failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/beta");
  return { status: "success", message: "Revoked." };
}

export async function submitFeedbackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const category = str(formData, "category");
  if (!isEnumValue(FeedbackCategory, category)) return { status: "error", message: "Choose what this is about." };
  const result = await submitFeedback(
    { db },
    { userId: user.id, category, message: str(formData, "message"), pagePath: str(formData, "pagePath") || null },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "MESSAGE_REQUIRED":
        return { status: "error", message: "Tell us a little more (5 to 5,000 characters)." };
      case "RATE_LIMITED":
        return { status: "error", message: "You've sent a lot of feedback today. Thank you! Try again tomorrow." };
      case "ACCOUNT_RESTRICTED":
        return { status: "error", message: "This account can't send feedback. Contact support." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled feedback failure: ${String(exhaustive)}`);
      }
    }
  }
  return { status: "success", message: "Thanks. The team reads every message." };
}

export async function handleFeedbackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const status = str(formData, "status");
  if (!isEnumValue(FeedbackStatus, status)) return { status: "error", message: "Choose a status." };
  const result = await handleFeedback(
    { db },
    { actorId: staff.id, feedbackId: str(formData, "feedbackId"), status, notes: str(formData, "notes") },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "UNCHANGED":
        return { status: "error", message: "Nothing changed." };
      case "NOT_FOUND":
      case "NOT_STAFF":
        return { status: "error", message: "That feedback isn't available." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled feedback update failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin/feedback");
  return { status: "success", message: "Saved." };
}

export async function recordDailyReviewAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const result = await recordDailyReview({ db }, { actorId: staff.id, notes: str(formData, "notes") }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "ALREADY_DONE":
        return { status: "error", message: "Today's review is already signed off." };
      case "NOT_STAFF":
        return { status: "error", message: "That action isn't available." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled daily review failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { status: "success", message: "Today's review is signed off." };
}
