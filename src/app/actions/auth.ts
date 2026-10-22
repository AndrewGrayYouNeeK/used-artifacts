"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import {
  EmailSchema,
  SignupSchema,
  login,
  logout,
  requestPasswordReset,
  resetPassword,
  signup,
  verifyEmail,
} from "@/domains/identity/accounts";
import { PasswordSchema } from "@/lib/auth/password";
import { requireOwner } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { identityDeps } from "@/lib/identity-deps";
import {
  clearSessionCookie,
  readSessionCookie,
  requestContext,
  setSessionCookie,
} from "@/lib/auth/session";

export type FormState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string[] | undefined> }
  | { status: "success"; message: string };

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "");

export async function signupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = SignupSchema.safeParse({
    email: str(formData, "email"),
    displayName: str(formData, "displayName"),
    password: str(formData, "password"),
    referralCode: str(formData, "ref") || undefined,
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: "Please fix the highlighted fields.",
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    };
  }
  const result = await signup(identityDeps(), parsed.data, await requestContext());
  if (!result.ok) {
    return { status: "error", message: "An account with that email already exists. Try signing in." };
  }
  return {
    status: "success",
    message: `Check ${parsed.data.email} for a link to verify your email, then sign in.`,
  };
}

export async function verifyEmailAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await verifyEmail(identityDeps(), str(formData, "token"));
  if (!result.ok) {
    return {
      status: "error",
      message: "This verification link is invalid, already used, or expired. Sign in to get a new one.",
    };
  }
  return { status: "success", message: "Email verified. You can sign in now." };
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await login(
    identityDeps(),
    { email: str(formData, "email"), password: str(formData, "password") },
    await requestContext(),
  );
  if (!result.ok) {
    switch (result.reason) {
      case "INVALID_CREDENTIALS":
        return { status: "error", message: "Email or password is incorrect." };
      case "EMAIL_NOT_VERIFIED":
        return {
          status: "error",
          message: "Verify your email first. We just sent you a new verification link.",
        };
      case "ACCOUNT_DISABLED":
        return { status: "error", message: "This account is suspended. Contact support." };
      default: {
        const exhaustive: never = result.reason;
        throw new Error(`Unhandled login failure: ${String(exhaustive)}`);
      }
    }
  }
  await setSessionCookie(result.sessionToken, result.expiresAt);
  redirect("/account");
}

export async function logoutAction() {
  const token = await readSessionCookie();
  if (token) await logout({ db }, token);
  await clearSessionCookie();
  redirect("/");
}

export async function forgotPasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = EmailSchema.safeParse(str(formData, "email"));
  if (!email.success) {
    return { status: "error", message: "Enter a valid email address." };
  }
  await requestPasswordReset(identityDeps(), { email: email.data }, await requestContext());
  return {
    status: "success",
    message:
      "If that email belongs to a verified account, a reset link is on its way. It expires in 30 minutes.",
  };
}

export async function resetPasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const password = PasswordSchema.safeParse(str(formData, "password"));
  if (!password.success) {
    return {
      status: "error",
      message: "Please choose a stronger password.",
      fieldErrors: { password: password.error.issues.map((i) => i.message) },
    };
  }
  if (password.data !== str(formData, "confirmPassword")) {
    return { status: "error", message: "Passwords don't match." };
  }
  const result = await resetPassword(
    identityDeps(),
    { token: str(formData, "token"), newPassword: password.data },
    await requestContext(),
  );
  if (!result.ok) {
    return {
      status: "error",
      message: "This reset link is invalid, already used, or expired. Request a new one.",
    };
  }
  await clearSessionCookie();
  return {
    status: "success",
    message: "Password updated. All devices were signed out. Sign in with your new password.",
  };
}

/** GM dashboard: sends the user the standard reset email. There is no "set password" action. */
export async function ownerSendPasswordResetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const owner = await requireOwner();
  const target = await db.user.findUnique({
    where: { id: str(formData, "userId") },
    select: { email: true, emailVerifiedAt: true },
  });
  if (!target?.emailVerifiedAt) {
    return { status: "error", message: "That user has no verified email, so no reset can be sent." };
  }
  const outcome = await requestPasswordReset(
    identityDeps(),
    { email: target.email, requestedByUserId: owner.id },
    await requestContext(),
  );
  switch (outcome) {
    case "SENT":
      return { status: "success", message: `Reset email sent to ${target.email}.` };
    case "RATE_LIMITED":
      return { status: "error", message: "Too many reset emails in the last hour. Try again later." };
    case "SKIPPED":
      return { status: "error", message: "No reset email was sent for this account." };
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled reset outcome: ${String(exhaustive)}`);
    }
  }
}
