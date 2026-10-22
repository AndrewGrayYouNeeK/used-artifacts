import { afterAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/crypto";
import {
  PASSWORD_RESET_MAX_PER_HOUR,
  PASSWORD_RESET_TTL_MS,
  login,
  requestPasswordReset,
  resetPassword,
  signup,
  verifyEmail,
} from "./accounts";
import { createVerifiedUser, extractToken, testDb, testDeps, uniqueEmail } from "../../../test/helpers";

const db = testDb();
afterAll(() => db.$disconnect());

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a much better passphrase";

describe("signup and email verification", () => {
  it("requires a verified email before login, and verification links are single-use", async () => {
    const deps = testDeps(db);
    const email = uniqueEmail();
    expect(await signup(deps, { email, displayName: "Andrew", password: PASSWORD })).toEqual({ ok: true });
    expect(await signup(deps, { email, displayName: "Dup", password: PASSWORD })).toEqual({
      ok: false,
      reason: "EMAIL_TAKEN",
    });

    const unverified = await login(deps, { email, password: PASSWORD });
    expect(unverified).toEqual({ ok: false, reason: "EMAIL_NOT_VERIFIED" });

    const token = extractToken(deps.mailer.sent[0].text);
    expect((await verifyEmail(deps, token)).ok).toBe(true);
    expect(await verifyEmail(deps, token)).toEqual({ ok: false, reason: "INVALID_OR_EXPIRED" });

    const loggedIn = await login(deps, { email, password: PASSWORD });
    expect(loggedIn.ok).toBe(true);
  });

  it("does not store raw tokens", async () => {
    const deps = testDeps(db);
    const email = uniqueEmail();
    await signup(deps, { email, displayName: "Raw", password: PASSWORD });
    const token = extractToken(deps.mailer.sent[0].text);
    const stored = await db.emailVerificationToken.findFirstOrThrow({ where: { email } });
    expect(stored.tokenHash).toBe(sha256Hex(token));
    expect(stored.tokenHash).not.toContain(token);
  });
});

describe("password reset only via a verified email link the user completes", () => {
  it("resets the password, burns the token, and revokes every session", async () => {
    const deps = testDeps(db);
    const user = await createVerifiedUser(db, { password: PASSWORD });
    const s1 = await login(deps, { email: user.email, password: PASSWORD });
    const s2 = await login(deps, { email: user.email, password: PASSWORD });
    expect(s1.ok && s2.ok).toBe(true);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(2);

    expect(await requestPasswordReset(deps, { email: user.email })).toBe("SENT");
    const mail = deps.mailer.sent.at(-1)!;
    expect(mail.to).toBe(user.email);
    const token = extractToken(mail.text);

    expect(await resetPassword(deps, { token, newPassword: NEW_PASSWORD })).toEqual({
      ok: true,
      userId: user.id,
    });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(deps.mailer.sent.at(-1)!.subject).toMatch(/password was changed/);

    expect(await resetPassword(deps, { token, newPassword: "yet another passphrase" })).toEqual({
      ok: false,
      reason: "INVALID_OR_EXPIRED",
    });
    expect((await login(deps, { email: user.email, password: PASSWORD })).ok).toBe(false);
    expect((await login(deps, { email: user.email, password: NEW_PASSWORD })).ok).toBe(true);
  });

  it("rejects expired tokens", async () => {
    const start = new Date("2026-10-22T12:00:00Z");
    let now = start;
    const deps = testDeps(db, () => now);
    const user = await createVerifiedUser(db);
    await requestPasswordReset(deps, { email: user.email });
    const token = extractToken(deps.mailer.sent.at(-1)!.text);

    now = new Date(start.getTime() + PASSWORD_RESET_TTL_MS + 1);
    expect(await resetPassword(deps, { token, newPassword: NEW_PASSWORD })).toEqual({
      ok: false,
      reason: "INVALID_OR_EXPIRED",
    });
  });

  it("never emails a reset link to an unverified address", async () => {
    const deps = testDeps(db);
    const email = uniqueEmail();
    await signup(deps, { email, displayName: "Unverified", password: PASSWORD });
    const before = deps.mailer.sent.length;
    expect(await requestPasswordReset(deps, { email })).toBe("SKIPPED");
    expect(deps.mailer.sent.length).toBe(before);
  });

  it("gives no signal for unknown emails", async () => {
    const deps = testDeps(db);
    expect(await requestPasswordReset(deps, { email: uniqueEmail("nobody") })).toBe("SKIPPED");
    expect(deps.mailer.sent).toHaveLength(0);
  });

  it("rate-limits reset emails per account", async () => {
    const deps = testDeps(db);
    const user = await createVerifiedUser(db);
    for (let i = 0; i < PASSWORD_RESET_MAX_PER_HOUR; i++) {
      expect(await requestPasswordReset(deps, { email: user.email })).toBe("SENT");
    }
    expect(await requestPasswordReset(deps, { email: user.email })).toBe("RATE_LIMITED");
  });

  it("an owner-triggered reset still goes only to the user and is audited as an admin action", async () => {
    const deps = testDeps(db);
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const user = await createVerifiedUser(db);
    expect(await requestPasswordReset(deps, { email: user.email, requestedByUserId: owner.id })).toBe("SENT");
    expect(deps.mailer.sent.map((m) => m.to)).toEqual([user.email]);

    const event = await db.auditEvent.findFirstOrThrow({
      where: { action: "admin.password_reset_email_sent", subjectId: user.id },
    });
    expect(event.actorUserId).toBe(owner.id);
    expect(event.actorType).toBe("ADMIN");
  });
});
