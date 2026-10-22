"use server";

import { revalidatePath } from "next/cache";
import {
  confirmTwoFactorEnrollment,
  disableTwoFactor,
  regenerateRecoveryCodes,
  startTwoFactorEnrollment,
  type TwoFactorDeps,
} from "@/domains/identity/two-factor";
import { serverEnv } from "@/config/env";
import { requireUser } from "@/lib/auth/dal";
import { verifyPassword } from "@/lib/auth/password";
import { requestContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getMailer } from "@/lib/email/mailer";

export type SecurityFormState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; message: string }
  | { status: "codes"; message: string; recoveryCodes: string[] };

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

function twoFactorDeps(): TwoFactorDeps {
  return { db, twoFactorKey: serverEnv().TWO_FACTOR_ENCRYPTION_KEY, mailer: getMailer() };
}

export async function startTwoFactorAction(): Promise<void> {
  const user = await requireUser();
  await startTwoFactorEnrollment(twoFactorDeps(), user.id);
  revalidatePath("/account/security");
}

export async function confirmTwoFactorAction(_prev: SecurityFormState, formData: FormData): Promise<SecurityFormState> {
  const user = await requireUser();
  const result = await confirmTwoFactorEnrollment(
    twoFactorDeps(),
    { userId: user.id, code: str(formData, "code"), sessionId: user.sessionId },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "INVALID_CODE":
        return { status: "error", message: "That code didn't match. Check the time on your phone and enter the newest code." };
      case "NO_PENDING_ENROLLMENT":
        return { status: "error", message: "Setup expired or is already finished. Reload the page." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled enrollment failure: ${String(exhaustive)}`);
      }
    }
  }
  return {
    status: "codes",
    message: "Two-factor sign-in is on. Save these recovery codes somewhere safe; each works once if you lose your phone.",
    recoveryCodes: result.recoveryCodes,
  };
}

export async function regenerateRecoveryCodesAction(_prev: SecurityFormState, formData: FormData): Promise<SecurityFormState> {
  const user = await requireUser();
  const result = await regenerateRecoveryCodes(twoFactorDeps(), { userId: user.id, code: str(formData, "code") }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "INVALID_CODE":
        return { status: "error", message: "Enter the current code from your authenticator app." };
      case "NOT_ENABLED":
        return { status: "error", message: "Two-factor sign-in isn't on." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled recovery code failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/account/security");
  return { status: "codes", message: "New recovery codes. The old ones no longer work.", recoveryCodes: result.recoveryCodes };
}

export async function disableTwoFactorAction(_prev: SecurityFormState, formData: FormData): Promise<SecurityFormState> {
  const user = await requireUser();
  const account = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
  const password = str(formData, "password");
  if (!password || !(await verifyPassword(account.passwordHash, password))) {
    return { status: "error", message: "Your password is incorrect." };
  }
  const result = await disableTwoFactor(twoFactorDeps(), { userId: user.id, code: str(formData, "code") }, await requestContext());
  if (!result.ok) {
    switch (result.reason) {
      case "INVALID_CODE":
        return { status: "error", message: "Enter a current authenticator code or an unused recovery code." };
      case "NOT_ENABLED":
        return { status: "error", message: "Two-factor sign-in isn't on." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled disable failure: ${String(exhaustive)}`);
      }
    }
  }
  revalidatePath("/account/security");
  return { status: "success", message: "Two-factor sign-in is off." };
}
