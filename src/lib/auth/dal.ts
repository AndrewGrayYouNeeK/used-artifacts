import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { readSessionCookie } from "@/lib/auth/session";
import type { UserRole } from "@/generated/prisma/enums";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

/**
 * Validates the session against the database on every request, so a password
 * reset or ban takes effect immediately. Deliberately not wrapped in
 * `use cache: private`, which would let a revoked session keep rendering.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = await readSessionCookie();
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: {
      expiresAt: true,
      user: {
        select: { id: true, email: true, displayName: true, role: true, status: true },
      },
    },
  });
  if (!session || session.expiresAt <= new Date() || session.user.status !== "ACTIVE") {
    return null;
  }
  const { id, email, displayName, role } = session.user;
  return { id, email, displayName, role };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireOwner(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "OWNER") redirect("/");
  return user;
}

/** Owner or moderator: compliance and identity review. */
export async function requireStaff(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "OWNER" && user.role !== "MODERATOR") redirect("/");
  return user;
}
