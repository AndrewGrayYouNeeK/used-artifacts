import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";

// `Algorithm` is an ambient const enum, which isolatedModules can't import.
const ARGON2ID = 2;

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations).
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PasswordSchema = z
  .string()
  .min(12, { error: "Use at least 12 characters." })
  .max(256, { error: "Use at most 256 characters." });

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Burns the same CPU as a real check so unknown emails can't be detected by timing. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword("dummy-password-for-timing-equalisation");
  await verifyPassword(await dummyHash, password);
  return false;
}
