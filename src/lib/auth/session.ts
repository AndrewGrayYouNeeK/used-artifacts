import "server-only";
import { cookies, headers } from "next/headers";
import { serverEnv } from "@/config/env";
import { generateToken, hmacHex } from "@/lib/crypto";

export const SESSION_COOKIE = "ua_session";
const TWO_FACTOR_CHALLENGE_COOKIE = "ua_2fa_challenge";
const DEVICE_COOKIE = "ua_device";
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2;

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function readSessionCookie(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Holds the sign-in challenge between the password step and the authenticator-code step. */
export async function setTwoFactorChallengeCookie(token: string, expiresAt: Date) {
  (await cookies()).set(TWO_FACTOR_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/login",
    expires: expiresAt,
  });
}

export async function readTwoFactorChallengeCookie(): Promise<string | undefined> {
  return (await cookies()).get(TWO_FACTOR_CHALLENGE_COOKIE)?.value;
}

export async function clearTwoFactorChallengeCookie() {
  (await cookies()).delete({ name: TWO_FACTOR_CHALLENGE_COOKIE, path: "/login" });
}

/** Long-lived random device id; only its keyed hash is stored (linkage signals). */
async function deviceId(): Promise<string | null> {
  const jar = await cookies();
  const existing = jar.get(DEVICE_COOKIE)?.value;
  if (existing) return existing;
  const id = generateToken();
  try {
    jar.set(DEVICE_COOKIE, id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: DEVICE_COOKIE_MAX_AGE,
    });
  } catch {
    // Cookies are read-only while rendering; the next action sets it.
    return null;
  }
  return id;
}

export async function requestContext() {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  const secret = serverEnv().IP_HASH_SECRET;
  const device = await deviceId();
  return {
    ipHash: ip ? hmacHex(secret, ip) : null,
    userAgent: h.get("user-agent"),
    deviceIdHash: device ? hmacHex(secret, `device:${device}`) : null,
  };
}
