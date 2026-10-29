import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  TEST_TWO_FACTOR_KEY,
  createLiveListing,
  createVerifiedUser,
  testDb,
  testDeps,
  testPhotos,
  uniqueEmail,
} from "../../../test/helpers";
import { loadPlatformConfig } from "@/config/platform";
import { totpCode } from "@/lib/auth/totp";
import { sha256Hex } from "@/lib/crypto";
import { FakeVisionProvider } from "@/domains/ai/fake-vision";
import { suggestFromPhotos } from "@/domains/ai/analyzer";
import { completeTwoFactorLogin, login, signup, LOGIN_CHALLENGE_MAX_ATTEMPTS } from "@/domains/identity/accounts";
import {
  confirmTwoFactorEnrollment,
  consumeSecondFactor,
  disableTwoFactor,
  startTwoFactorEnrollment,
  twoFactorStatus,
} from "@/domains/identity/two-factor";
import { createBetaInvite, normalizeInviteCode, revokeBetaInvite } from "@/domains/growth/beta-invites";
import { submitListing } from "@/domains/listings/listings";
import { startCheckout } from "@/domains/orders/checkout";
import { confirmReceipt, markShipped, recordDelivery } from "@/domains/orders/fulfillment";
import { runEscrowJobs } from "@/domains/orders/jobs";
import { processPaymentEvent } from "@/domains/orders/payment-events";
import { FakePaymentsProvider, fakeCheckoutCompleted } from "@/domains/payments/fake-provider";
import type { OrdersDeps } from "@/domains/orders/deps";
import { isPaused, setKillSwitch } from "./kill-switches";
import { handleFeedback, submitFeedback, FEEDBACK_DAILY_LIMIT } from "./feedback";
import { recordDailyReview, sendDailyDigest } from "./daily-review";

const db = testDb();
afterAll(() => db.$disconnect());
afterEach(() => db.killSwitch.deleteMany());

const PASSWORD = "correct horse battery";
const inviteOnly = loadPlatformConfig({ BETA_INVITE_REQUIRED: "true" });
const inviteDeps = () => ({ ...testDeps(db), platform: inviteOnly });
const signupInput = (email = uniqueEmail(), inviteCode?: string) => ({ email, displayName: "Beta Tester", password: PASSWORD, inviteCode });

async function newInvite(opts: { email?: string; maxUses?: number; expiresInDays?: number; now?: () => Date } = {}) {
  const owner = await createVerifiedUser(db, { role: "OWNER" });
  const result = await createBetaInvite(
    { db, appUrl: "http://test.local", now: opts.now },
    { actorId: owner.id, note: "Test invite", email: opts.email, maxUses: opts.maxUses ?? 1, expiresInDays: opts.expiresInDays },
  );
  if (!result.ok) throw new Error(result.reason);
  return { owner, ...result };
}

describe("beta invites", () => {
  it("gates signup on a valid owner-issued code, stores only its hash, and spends one use per signup", async () => {
    const deps = inviteDeps();
    expect(await signup(deps, signupInput())).toEqual({ ok: false, reason: "INVITE_REQUIRED" });

    const badEmail = uniqueEmail();
    expect(await signup(deps, signupInput(badEmail, "NOPE-NOPE-NOPE"))).toEqual({ ok: false, reason: "INVITE_INVALID" });
    expect(await db.user.findUnique({ where: { email: badEmail } })).toBeNull();

    const { inviteId, code, link } = await newInvite();
    expect(link).toBe(`http://test.local/signup?invite=${encodeURIComponent(code)}`);
    const stored = await db.betaInvite.findUniqueOrThrow({ where: { id: inviteId } });
    expect(stored.codeHash).not.toContain(normalizeInviteCode(code));
    expect(stored.codeHint).toBe(normalizeInviteCode(code).slice(-4));

    const email = uniqueEmail();
    expect(await signup(deps, signupInput(email, code.toLowerCase().replaceAll("-", " ")))).toEqual({ ok: true });
    const user = await db.user.findUniqueOrThrow({ where: { email }, include: { betaInviteRedemption: true } });
    expect(user.betaInviteRedemption?.inviteId).toBe(inviteId);
    expect(await signup(deps, signupInput(uniqueEmail(), code))).toEqual({ ok: false, reason: "INVITE_INVALID" });
    expect((await db.betaInvite.findUniqueOrThrow({ where: { id: inviteId } })).useCount).toBe(1);
  });

  it("honors the email lock, expiry, and revocation", async () => {
    const deps = inviteDeps();
    const locked = uniqueEmail("locked");
    const lockedInvite = await newInvite({ email: ` ${locked.toUpperCase()} ` });
    expect(await signup(deps, signupInput(uniqueEmail(), lockedInvite.code))).toEqual({ ok: false, reason: "INVITE_INVALID" });
    expect(await signup(deps, signupInput(locked, lockedInvite.code))).toEqual({ ok: true });

    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const expired = await newInvite({ expiresInDays: 1, now: () => past });
    expect(await signup(deps, signupInput(uniqueEmail(), expired.code))).toEqual({ ok: false, reason: "INVITE_INVALID" });

    const revoked = await newInvite({ maxUses: 5 });
    expect(await revokeBetaInvite({ db }, { actorId: revoked.owner.id, inviteId: revoked.inviteId })).toEqual({ ok: true });
    expect(await revokeBetaInvite({ db }, { actorId: revoked.owner.id, inviteId: revoked.inviteId })).toEqual({ ok: false, reason: "ALREADY_REVOKED" });
    expect(await signup(deps, signupInput(uniqueEmail(), revoked.code))).toEqual({ ok: false, reason: "INVITE_INVALID" });
  });

  it("lets only PROPRIETOR_EMAIL skip the invite, and only before the Proprietor exists", async () => {
    const ownerEmail = uniqueEmail("owner");
    const deps = { ...inviteDeps(), ownerBootstrapEmail: ownerEmail };
    const hasProprietor = (await db.proprietor.count()) > 0;
    expect(await signup(deps, signupInput())).toEqual({ ok: false, reason: "INVITE_REQUIRED" });
    expect(await signup(deps, signupInput(ownerEmail))).toEqual(hasProprietor ? { ok: false, reason: "INVITE_REQUIRED" } : { ok: true });
  });

  it("can't be overspent by concurrent signups", async () => {
    const deps = inviteDeps();
    const { inviteId, code } = await newInvite({ maxUses: 2 });
    const results = await Promise.all(Array.from({ length: 5 }, () => signup(deps, signupInput(uniqueEmail(), code))));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await db.betaInviteRedemption.count({ where: { inviteId } })).toBe(2);
  });

  it("is owner-only, and the database keeps invite terms and redemptions immutable", async () => {
    const moderator = await createVerifiedUser(db, { role: "MODERATOR" });
    expect(await createBetaInvite({ db, appUrl: "http://test.local" }, { actorId: moderator.id, note: "x y", maxUses: 1 })).toEqual({
      ok: false,
      reason: "OWNER_ONLY",
    });
    const { inviteId, owner } = await newInvite();
    expect(await createBetaInvite({ db, appUrl: "http://test.local" }, { actorId: owner.id, note: "Bulk", maxUses: 5000 })).toEqual({
      ok: false,
      reason: "INVALID_USES",
    });
    await expect(db.betaInvite.update({ where: { id: inviteId }, data: { maxUses: 50 } })).rejects.toThrow(/immutable/);
    await expect(db.betaInvite.update({ where: { id: inviteId }, data: { useCount: 1 } })).resolves.toBeTruthy();
    await expect(db.betaInvite.update({ where: { id: inviteId }, data: { useCount: 0 } })).rejects.toThrow(/one at a time/);
    await expect(db.betaInvite.delete({ where: { id: inviteId } })).rejects.toThrow(/cannot be deleted/);
  });

  it("emails a locked invite when asked", async () => {
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const mailer = testDeps(db).mailer;
    const email = uniqueEmail("friend");
    const result = await createBetaInvite({ db, appUrl: "http://test.local", mailer }, { actorId: owner.id, note: "Friend", email, maxUses: 1, sendEmail: true });
    if (!result.ok) throw new Error(result.reason);
    expect(result.emailed).toBe(true);
    expect(mailer.sent[0]).toMatchObject({ to: email });
    expect(mailer.sent[0].text).toContain(result.code);
  });
});

function ordersDeps(): OrdersDeps & { payments: FakePaymentsProvider } {
  return { db, payments: new FakePaymentsProvider("http://test.local"), appUrl: "http://test.local", linkageSecret: "x".repeat(32) };
}

describe("kill switches", () => {
  it("lets any staff member pause, only the owner resume, and audits both", async () => {
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const moderator = await createVerifiedUser(db, { role: "MODERATOR" });
    const member = await createVerifiedUser(db);
    expect(await setKillSwitch({ db }, { actorId: member.id, key: "CHECKOUT", paused: true, reason: "testing it" })).toEqual({ ok: false, reason: "NOT_STAFF" });
    expect(await setKillSwitch({ db }, { actorId: moderator.id, key: "CHECKOUT", paused: true, reason: "" })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    expect(await setKillSwitch({ db }, { actorId: moderator.id, key: "CHECKOUT", paused: true, reason: "Card testing spike" })).toEqual({ ok: true });
    expect(await isPaused(db, "CHECKOUT")).toBe(true);
    expect(await setKillSwitch({ db }, { actorId: moderator.id, key: "CHECKOUT", paused: false, reason: "All clear now" })).toEqual({ ok: false, reason: "OWNER_ONLY" });
    expect(await setKillSwitch({ db }, { actorId: owner.id, key: "CHECKOUT", paused: false, reason: "All clear now" })).toEqual({ ok: true });
    expect(await isPaused(db, "CHECKOUT")).toBe(false);
    const events = await db.auditEvent.findMany({ where: { subjectType: "KillSwitch", subjectId: "CHECKOUT" }, orderBy: { seq: "asc" } });
    expect(events.slice(-2).map((e) => e.action)).toEqual(["platform.kill_switch_paused", "platform.kill_switch_resumed"]);
    await expect(db.killSwitch.update({ where: { key: "CHECKOUT" }, data: { paused: true, reason: null } })).rejects.toThrow(/kill_switch_pause_reason/);
  });

  it("stops signups, listings, checkout, and suggestions while paused", async () => {
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const pause = (key: "SIGNUPS" | "LISTINGS" | "CHECKOUT" | "AI_ANALYZER") => setKillSwitch({ db }, { actorId: owner.id, key, paused: true, reason: "Incident drill" });

    await pause("SIGNUPS");
    expect(await signup(testDeps(db), signupInput())).toEqual({ ok: false, reason: "SIGNUPS_PAUSED" });

    const { seller, listingId } = await createLiveListing(db);
    await pause("LISTINGS");
    const submitted = await submitListing(
      { db, vision: new FakeVisionProvider() },
      { userId: seller.id, photos: testPhotos(), submission: { categoryId: "x", title: "t", description: "d", askingPrice: 100, shipping: 0, acquisitionSource: "PURCHASED", acquisitionDetails: "", attestationKeys: [], iacaAcknowledged: false, signedName: "" } },
    );
    expect(submitted).toEqual({ ok: false, reason: "LISTINGS_PAUSED" });

    await pause("CHECKOUT");
    const buyer = await createVerifiedUser(db);
    expect(await startCheckout(ordersDeps(), { buyerUserId: buyer.id, buyerEmail: "b@example.com", listingId })).toEqual({ ok: false, reason: "CHECKOUT_PAUSED" });

    await pause("AI_ANALYZER");
    expect(await suggestFromPhotos({ db, vision: new FakeVisionProvider() }, { userId: seller.id, photos: [{ bytes: new Uint8Array(0), pHash: "00" }] })).toEqual({
      ok: false,
      reason: "PAUSED",
    });
  });

  it("holds seller transfers while payouts are paused and sends them once resumed", async () => {
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const deps = ordersDeps();
    const { seller, listingId } = await createLiveListing(db);
    const buyer = await createVerifiedUser(db);
    const checkout = await startCheckout(deps, { buyerUserId: buyer.id, buyerEmail: "b@example.com", listingId });
    if (!checkout.ok) throw new Error(checkout.reason);
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });
    await processPaymentEvent(
      deps,
      fakeCheckoutCompleted({
        checkoutSessionId: payment.checkoutSessionId,
        amountCents: payment.amountCents,
        taxCents: 0,
        shippingAddress: { name: "Bea Buyer", line1: "1 Main St", city: "Louisville", state: "KY", postalCode: "40202", country: "US" },
        paymentFingerprint: `card_${checkout.orderId}`,
      }),
    );
    await markShipped(deps, { sellerUserId: seller.id, orderId: checkout.orderId, carrier: "USPS", trackingNumber: "9400111899223197428490" });
    await recordDelivery(deps, { orderId: checkout.orderId, deliveredAt: new Date(), source: "CARRIER" });

    await setKillSwitch({ db }, { actorId: owner.id, key: "PAYOUTS", paused: true, reason: "Bank account mixup" });
    expect(await confirmReceipt(deps, { buyerUserId: buyer.id, orderId: checkout.orderId })).toMatchObject({ ok: true });
    const held = await db.transfer.findFirstOrThrow({ where: { orderId: checkout.orderId } });
    expect(held).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(deps.payments.transfers).toHaveLength(0);

    await setKillSwitch({ db }, { actorId: owner.id, key: "PAYOUTS", paused: false, reason: "Sorted out" });
    await runEscrowJobs(deps);
    expect((await db.transfer.findUniqueOrThrow({ where: { id: held.id } })).status).toBe("PAID");
  });
});

describe("two-factor sign-in", () => {
  it("enrolls with a confirmed code, then requires a code at sign-in, refusing replays", async () => {
    let now = new Date("2030-06-01T12:00:00Z");
    const clock = () => now;
    const deps = { ...testDeps(db, clock) };
    const tf = { db, twoFactorKey: TEST_TWO_FACTOR_KEY, mailer: deps.mailer, now: clock };
    const user = await createVerifiedUser(db, { role: "OWNER", password: PASSWORD });

    const started = await startTwoFactorEnrollment(tf, user.id);
    if (!started.ok) throw new Error(started.reason);
    const stored = await db.twoFactorCredential.findUniqueOrThrow({ where: { userId: user.id } });
    expect(stored.secretEncrypted).not.toContain(started.secret);
    expect((await login(deps, { email: user.email, password: PASSWORD })).ok).toBe(true);

    expect(await confirmTwoFactorEnrollment(tf, { userId: user.id, code: "000000" })).toEqual({ ok: false, reason: "INVALID_CODE" });
    const confirmed = await confirmTwoFactorEnrollment(tf, { userId: user.id, code: totpCode(started.secret, now) });
    if (!confirmed.ok) throw new Error(confirmed.reason);
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(await startTwoFactorEnrollment(tf, user.id)).toEqual({ ok: false, reason: "ALREADY_ENABLED" });

    const first = await login(deps, { email: user.email, password: PASSWORD });
    if (first.ok || first.reason !== "TWO_FACTOR_REQUIRED") throw new Error("expected a challenge");
    expect(await completeTwoFactorLogin(deps, { challengeToken: first.challengeToken, code: totpCode(started.secret, now) })).toEqual({
      ok: false,
      reason: "INVALID_CODE",
    });
    now = new Date(now.getTime() + 30_000);
    const ok = await completeTwoFactorLogin(deps, { challengeToken: first.challengeToken, code: totpCode(started.secret, now) });
    if (!ok.ok) throw new Error(ok.reason);
    const session = await db.session.findUniqueOrThrow({ where: { tokenHash: sha256Hex(ok.sessionToken) } });
    expect(session.twoFactorVerifiedAt).not.toBeNull();
    expect(await completeTwoFactorLogin(deps, { challengeToken: first.challengeToken, code: totpCode(started.secret, now) })).toEqual({
      ok: false,
      reason: "CHALLENGE_EXPIRED",
    });
    await expect(db.twoFactorCredential.update({ where: { userId: user.id }, data: { lastUsedStep: 1 } })).rejects.toThrow(/only move forward/);
  });

  it("accepts each recovery code once and burns a challenge after too many wrong codes", async () => {
    const deps = testDeps(db);
    const tf = { db, twoFactorKey: TEST_TWO_FACTOR_KEY };
    const user = await createVerifiedUser(db, { password: PASSWORD });
    const started = await startTwoFactorEnrollment(tf, user.id);
    if (!started.ok) throw new Error(started.reason);
    const confirmed = await confirmTwoFactorEnrollment(tf, { userId: user.id, code: totpCode(started.secret, new Date()) });
    if (!confirmed.ok) throw new Error(confirmed.reason);
    const [recovery] = confirmed.recoveryCodes;

    const challenge = await login(deps, { email: user.email, password: PASSWORD });
    if (challenge.ok || challenge.reason !== "TWO_FACTOR_REQUIRED") throw new Error("expected a challenge");
    expect((await completeTwoFactorLogin(deps, { challengeToken: challenge.challengeToken, code: recovery.toUpperCase() })).ok).toBe(true);
    expect(await consumeSecondFactor(tf, user.id, recovery)).toBeNull();
    expect((await twoFactorStatus(db, user.id)).recoveryCodesLeft).toBe(9);

    const second = await login(deps, { email: user.email, password: PASSWORD });
    if (second.ok || second.reason !== "TWO_FACTOR_REQUIRED") throw new Error("expected a challenge");
    for (let i = 0; i < LOGIN_CHALLENGE_MAX_ATTEMPTS; i++) {
      expect((await completeTwoFactorLogin(deps, { challengeToken: second.challengeToken, code: "111111" })).ok).toBe(false);
    }
    expect(await completeTwoFactorLogin(deps, { challengeToken: second.challengeToken, code: confirmed.recoveryCodes[1] })).toEqual({
      ok: false,
      reason: "CHALLENGE_EXPIRED",
    });
  });

  it("turns off only with a valid code, and clears verified sessions", async () => {
    let now = new Date("2030-07-01T12:00:00Z");
    const tf = { db, twoFactorKey: TEST_TWO_FACTOR_KEY, now: () => now };
    const user = await createVerifiedUser(db, { password: PASSWORD });
    const started = await startTwoFactorEnrollment(tf, user.id);
    if (!started.ok) throw new Error(started.reason);
    await confirmTwoFactorEnrollment(tf, { userId: user.id, code: totpCode(started.secret, now) });
    expect(await disableTwoFactor(tf, { userId: user.id, code: "123456" })).toEqual({ ok: false, reason: "INVALID_CODE" });
    now = new Date(now.getTime() + 60_000);
    expect(await disableTwoFactor(tf, { userId: user.id, code: totpCode(started.secret, now) })).toEqual({ ok: true });
    expect(await twoFactorStatus(db, user.id)).toMatchObject({ enabled: false });
    expect(await db.twoFactorRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("feedback", () => {
  it("records member feedback with a daily limit, and staff triage it", async () => {
    const member = await createVerifiedUser(db);
    const moderator = await createVerifiedUser(db, { role: "MODERATOR" });
    expect(await submitFeedback({ db }, { userId: member.id, category: "BUG", message: "hi" })).toEqual({ ok: false, reason: "MESSAGE_REQUIRED" });
    const first = await submitFeedback({ db }, { userId: member.id, category: "TRUST_SAFETY", message: "This listing looks like a grave find.", pagePath: "/listings/abc" });
    if (!first.ok) throw new Error(first.reason);
    for (let i = 1; i < FEEDBACK_DAILY_LIMIT; i++) await submitFeedback({ db }, { userId: member.id, category: "IDEA", message: `Idea number ${i}` });
    expect(await submitFeedback({ db }, { userId: member.id, category: "IDEA", message: "One more idea" })).toEqual({ ok: false, reason: "RATE_LIMITED" });

    expect(await handleFeedback({ db }, { actorId: member.id, feedbackId: first.feedbackId, status: "CLOSED", notes: "" })).toEqual({ ok: false, reason: "NOT_STAFF" });
    expect(await handleFeedback({ db }, { actorId: moderator.id, feedbackId: first.feedbackId, status: "ACKNOWLEDGED", notes: "Escalated to compliance" })).toEqual({ ok: true });
    expect(await db.feedback.findUniqueOrThrow({ where: { id: first.feedbackId } })).toMatchObject({
      status: "ACKNOWLEDGED",
      staffNotes: "Escalated to compliance",
      handledById: moderator.id,
      pagePath: "/listings/abc",
    });
  });
});

describe("daily review and digest", () => {
  it("allows one staff sign-off per UTC day and keeps it permanent", async () => {
    const moderator = await createVerifiedUser(db, { role: "MODERATOR" });
    const member = await createVerifiedUser(db);
    const now = () => new Date("2031-03-04T18:00:00Z");
    expect(await recordDailyReview({ db, now }, { actorId: member.id, notes: "" })).toEqual({ ok: false, reason: "NOT_STAFF" });
    expect(await recordDailyReview({ db, now }, { actorId: moderator.id, notes: "Two signals dismissed" })).toEqual({ ok: true });
    expect(await recordDailyReview({ db, now }, { actorId: moderator.id, notes: "again" })).toEqual({ ok: false, reason: "ALREADY_DONE" });
    const review = await db.dailyReview.findUniqueOrThrow({ where: { day: new Date("2031-03-04T00:00:00Z") } });
    await expect(db.dailyReview.update({ where: { id: review.id }, data: { notes: "edited" } })).rejects.toThrow(/append-only/);
  });

  it("emails staff once per day after the digest hour", async () => {
    await createVerifiedUser(db, { role: "MODERATOR" });
    const staffCount = await db.user.count({ where: { role: { in: ["OWNER", "MODERATOR"] }, status: "ACTIVE", emailVerifiedAt: { not: null } } });
    const mailer = testDeps(db).mailer;
    const base = { db, mailer, appUrl: "http://test.local", platform: loadPlatformConfig({ DAILY_DIGEST_HOUR_UTC: "13" }) };
    expect(await sendDailyDigest({ ...base, now: () => new Date("2031-05-06T12:59:00Z") })).toEqual({ sent: false, reason: "TOO_EARLY" });
    expect(await sendDailyDigest({ ...base, now: () => new Date("2031-05-06T13:05:00Z") })).toEqual({ sent: true, recipients: staffCount });
    expect(await sendDailyDigest({ ...base, now: () => new Date("2031-05-06T23:00:00Z") })).toEqual({ sent: false, reason: "ALREADY_SENT" });
    expect(mailer.sent).toHaveLength(staffCount);
    expect(mailer.sent[0].text).toContain("Open fraud signals:");
    expect(mailer.sent[0].text).toContain("http://test.local/admin/trust");
  });
});
