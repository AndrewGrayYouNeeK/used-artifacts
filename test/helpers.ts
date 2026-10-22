import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@/lib/db";
import { MemoryMailer } from "@/lib/email/mailer";
import { hashPassword } from "@/lib/auth/password";
import type { IdentityDeps } from "@/domains/identity/accounts";
import type { UserRole } from "@/generated/prisma/enums";

export function testDb(): Db {
  return createDb(process.env.TEST_DATABASE_URL!);
}

export function testDeps(db: Db, now?: () => Date): IdentityDeps & { mailer: MemoryMailer } {
  return { db, mailer: new MemoryMailer(), appUrl: "http://test.local", now };
}

export function uniqueEmail(prefix = "user") {
  return `${prefix}-${randomUUID()}@example.com`;
}

export async function createVerifiedUser(
  db: Db,
  opts: { email?: string; password?: string; role?: UserRole } = {},
) {
  return db.user.create({
    data: {
      email: (opts.email ?? uniqueEmail()).trim().toLowerCase(),
      displayName: "Test User",
      passwordHash: await hashPassword(opts.password ?? "correct horse battery"),
      emailVerifiedAt: new Date(),
      role: opts.role ?? "USER",
    },
  });
}

export function extractToken(text: string): string {
  const match = text.match(/token=([^\s]+)/);
  if (!match) throw new Error(`No token link in email: ${text}`);
  return decodeURIComponent(match[1]);
}
