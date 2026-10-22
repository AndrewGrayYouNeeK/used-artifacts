"use server";

import { revalidatePath } from "next/cache";
import type { FormState } from "@/app/actions/auth";
import {
  ACCOUNT_ACTIONS,
  MANUAL_ENFORCEMENT_TYPES,
  liftEnforcementAction,
  reviewFraudSignal,
  setUserRole,
  takeEnforcementAction,
  type ManualEnforcementType,
} from "@/domains/admin/enforcement";
import { requireOwner, requireStaff } from "@/lib/auth/dal";
import { verifyPassword } from "@/lib/auth/password";
import { requestContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { identityDeps } from "@/lib/identity-deps";

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

/** Sensitive owner actions ask for the password again (a hijacked session alone isn't enough). */
async function reauthenticated(userId: string, password: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  return Boolean(user?.passwordHash && password && (await verifyPassword(user.passwordHash, password)));
}

const isManualType = (v: string): v is ManualEnforcementType => (MANUAL_ENFORCEMENT_TYPES as readonly string[]).includes(v);

export async function enforceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const type = str(formData, "type");
  if (!isManualType(type)) return { status: "error", message: "Choose an action." };
  if (ACCOUNT_ACTIONS.has(type) && !(await reauthenticated(staff.id, str(formData, "password")))) {
    return { status: "error", message: "Enter your password to confirm a suspension or ban." };
  }
  const days = Number(str(formData, "days"));
  const result = await takeEnforcementAction(
    identityDeps(),
    {
      actorId: staff.id,
      userId: str(formData, "userId"),
      type,
      reason: str(formData, "reason"),
      fraudSignalId: str(formData, "fraudSignalId") || null,
      listingId: str(formData, "listingId") || null,
      userBadgeId: str(formData, "userBadgeId") || null,
      suspensionDays: Number.isFinite(days) ? days : null,
    },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "REASON_REQUIRED":
        return { status: "error", message: "Give a reason (it's emailed to the user)." };
      case "SELF_ACTION":
        return { status: "error", message: "You can't take action against your own account." };
      case "TARGET_IS_OWNER":
        return { status: "error", message: "The owner account can't be restricted." };
      case "OWNER_ONLY":
        return { status: "error", message: "Only the owner can suspend or ban." };
      case "INVALID_DURATION":
        return { status: "error", message: "Suspensions last 1 to 365 days." };
      case "LISTING_NOT_REMOVABLE":
        return { status: "error", message: "That listing isn't live or pending, or isn't this user's." };
      case "LISTING_HAS_ACTIVE_ORDER":
        return { status: "error", message: "This listing has an order in progress. Resolve or refund the order first." };
      case "BADGE_NOT_FOUND":
        return { status: "error", message: "That badge isn't active on this account." };
      case "ALREADY_RESTRICTED":
        return { status: "error", message: "This account is already restricted." };
      case "NOT_STAFF":
      case "USER_NOT_FOUND":
        return { status: "error", message: "That action isn't available." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled enforcement failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin", "layout");
  return {
    status: "success",
    message: `Recorded and emailed to the user${result.listingsRemoved ? `; ${result.listingsRemoved} listing(s) removed` : ""}.`,
  };
}

export async function liftEnforcementFormAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const action = await db.enforcementAction.findUnique({ where: { id: str(formData, "enforcementId") }, select: { type: true } });
  if (action && ACCOUNT_ACTIONS.has(action.type) && !(await reauthenticated(staff.id, str(formData, "password")))) {
    return { status: "error", message: "Enter your password to restore an account." };
  }
  const result = await liftEnforcementAction(
    identityDeps(),
    { actorId: staff.id, enforcementId: str(formData, "enforcementId"), reason: str(formData, "reason") },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "REASON_REQUIRED":
        return { status: "error", message: "Record why it's being lifted (the appeal outcome)." };
      case "OWNER_ONLY":
        return { status: "error", message: "Only the owner can restore a suspended or banned account." };
      case "NOT_LIFTABLE":
        return { status: "error", message: "Removed listings stay removed; the seller can resubmit." };
      case "ALREADY_LIFTED":
        return { status: "error", message: "Already lifted." };
      case "NOT_STAFF":
      case "NOT_FOUND":
        return { status: "error", message: "That action isn't available." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled lift failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { status: "success", message: "Lifted." };
}

export async function reviewFraudSignalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const status = str(formData, "status");
  if (status !== "CONFIRMED" && status !== "DISMISSED") return { status: "error", message: "Choose confirm or dismiss." };
  const result = await reviewFraudSignal(
    { db },
    { actorId: staff.id, signalId: str(formData, "signalId"), status, notes: str(formData, "notes") },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "NOTES_REQUIRED":
        return { status: "error", message: "Add notes on what you found." };
      case "ALREADY_REVIEWED":
        return { status: "error", message: "Someone already reviewed this signal." };
      case "NOT_STAFF":
      case "NOT_FOUND":
        return { status: "error", message: "That signal isn't available." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled signal review failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { status: "success", message: status === "CONFIRMED" ? "Confirmed." : "Dismissed." };
}

export async function setUserRoleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const owner = await requireOwner();
  const role = str(formData, "role");
  if (role !== "USER" && role !== "MODERATOR") return { status: "error", message: "Choose a role." };
  if (!(await reauthenticated(owner.id, str(formData, "password")))) {
    return { status: "error", message: "Enter your password to change staff roles." };
  }
  const result = await setUserRole({ db }, { actorId: owner.id, userId: str(formData, "userId"), role }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "UNCHANGED":
        return { status: "error", message: "That's already their role." };
      case "TARGET_IS_OWNER":
      case "SELF_ACTION":
        return { status: "error", message: "The owner's role can't be changed here." };
      case "OWNER_ONLY":
      case "USER_NOT_FOUND":
        return { status: "error", message: "That action isn't available." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled role failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { status: "success", message: role === "MODERATOR" ? "Now a moderator." : "Moderator access removed." };
}
