import "server-only";
import { cookies, headers } from "next/headers";
import { serverEnv } from "@/config/env";
import { hmacHex } from "@/lib/crypto";

export const SESSION_COOKIE = "ua_session";

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

export async function requestContext() {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  return {
    ipHash: ip ? hmacHex(serverEnv().IP_HASH_SECRET, ip) : null,
    userAgent: h.get("user-agent"),
  };
}
