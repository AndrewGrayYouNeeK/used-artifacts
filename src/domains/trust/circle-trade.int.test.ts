import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createLiveListing, createVerifiedUser, markIdentityVerified, testDb, testDeps, testPhotos, uniqueEmail } from "../../../test/helpers";
import { decideAppeal, submitAppeal } from "@/domains/admin/appeals";
import { reviewFraudSignal, takeEnforcementAction } from "@/domains/admin/enforcement";
import { qualifyingOrderCount } from "@/domains/growth/badges";
import { ensureReferralCode } from "@/domains/growth/referrals";
import { signup } from "@/domains/identity/accounts";
import { FakePaymentsProvider, fakeCheckoutCompleted } from "@/domains/payments/fake-provider";
import { startCheckout } from "@/domains/orders/checkout";
import type { OrdersDeps } from "@/domains/orders/deps";
import { confirmReceipt, markShipped } from "@/domains/orders/fulfillment";
import { processPaymentEvent } from "@/domains/orders/payment-events";
import { findTradeCycles, runCircleTradeScan } from "./circle-trade";

const db = testDb();
afterAll(() => db.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const deps: OrdersDeps = { db, payments: new FakePaymentsProvider("http://test.local"), appUrl: "http://test.local", linkageSecret: "x".repeat(32) };

/** Buys, pays, ships, and confirms receipt, with a fresh card and address so the accounts don't get linked. */
async function sellAndRelease(listingId: string, buyer: { id: string }) {
  const checkout = await startCheckout(deps, { buyerUserId: buyer.id, buyerEmail: "b@example.com", listingId });
  if (!checkout.ok) throw new Error(checkout.reason);
  const payment = await db.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });
  await processPaymentEvent(
    deps,
    fakeCheckoutCompleted({
      checkoutSessionId: payment.checkoutSessionId,
      amountCents: payment.amountCents,
      taxCents: 0,
      shippingAddress: { name: "Buyer", line1: `${randomUUID().slice(0, 6)} Main St`, city: "Louisville", state: "KY", postalCode: "40202", country: "US" },
      paymentFingerprint: `card_${randomUUID()}`,
    }),
  );
  const order = await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } });
  await markShipped(deps, { sellerUserId: order.sellerUserId, orderId: order.id, carrier: "USPS", trackingNumber: "9400111899223197428490" });
  expect(await confirmReceipt(deps, { buyerUserId: buyer.id, orderId: order.id })).toEqual({ ok: true });
  return order.id;
}

/** A seller (verified, payout-ready storefront) with one live listing. */
async function seller() {
  const { seller, listingId } = await createLiveListing(db);
  return { user: seller, listingId };
}

const signalsFor = (orderId: string) =>
  db.fraudSignal.findMany({ where: { detector: "CIRCLE_TRADE", orders: { some: { orderId } } }, include: { orders: true } });

describe("circle-trade detection", () => {
  it("flags a three-account cycle once, links every order, and keeps it out of badge counts until dismissed", async () => {
    const a = await seller();
    const b = await seller();
    const c = await seller();
    const ab = await sellAndRelease(a.listingId, b.user);
    const bc = await sellAndRelease(b.listingId, c.user);
    const ca = await sellAndRelease(c.listingId, a.user);

    const cycles = await findTradeCycles(db, new Date(Date.now() - DAY));
    const ours = cycles.filter((cy) => cy.orderIds.includes(ab));
    expect(ours).toHaveLength(1);
    expect(ours[0].orderIds).toEqual([ab, bc, ca].sort());
    expect([...ours[0].userIds].sort()).toEqual([a.user.id, b.user.id, c.user.id].sort());

    const tx = (fn: Parameters<typeof db.$transaction>[0]) => db.$transaction(fn);
    expect(await tx((t) => qualifyingOrderCount(t, a.user.id, "SALES", 3))).toBe(1);

    const first = await runCircleTradeScan({ db }, { force: true });
    expect(first.skipped).toBe(false);
    const [signal] = await signalsFor(ab);
    expect(signal.orders.map((o) => o.orderId).sort()).toEqual([ab, bc, ca].sort());
    expect(signal.status).toBe("OPEN");
    expect(await tx((t) => qualifyingOrderCount(t, a.user.id, "SALES", 3))).toBe(0);
    expect(await tx((t) => qualifyingOrderCount(t, c.user.id, "PURCHASES", 3))).toBe(0);

    await runCircleTradeScan({ db }, { force: true });
    expect(await signalsFor(ab)).toHaveLength(1);
    expect(await runCircleTradeScan({ db })).toEqual({ skipped: true });

    await expect(db.fraudSignalOrder.deleteMany({ where: { signalId: signal.id } })).rejects.toThrow(/append-only/);

    const staff = await createVerifiedUser(db, { role: "MODERATOR" });
    expect(await reviewFraudSignal({ db }, { actorId: staff.id, signalId: signal.id, status: "DISMISSED", notes: "Three collectors who trade often." })).toEqual({ ok: true });
    expect(await tx((t) => qualifyingOrderCount(t, a.user.id, "SALES", 3))).toBe(1);
  });

  it("ignores a chain that doesn't close", async () => {
    const a = await seller();
    const b = await seller();
    const c = await seller();
    const ab = await sellAndRelease(a.listingId, b.user);
    await sellAndRelease(b.listingId, c.user);
    await runCircleTradeScan({ db }, { force: true });
    expect(await signalsFor(ab)).toHaveLength(0);
  });

  it("ignores cycles older than the 90-day window", async () => {
    const a = await seller();
    const b = await seller();
    const ab = await sellAndRelease(a.listingId, b.user);
    await sellAndRelease(b.listingId, a.user);
    await runCircleTradeScan({ db, now: () => new Date(Date.now() + 91 * DAY) }, { force: true });
    expect(await signalsFor(ab)).toHaveLength(0);
  });

  it("freezes referral credit on the orders in a cycle", async () => {
    const referrer = await createVerifiedUser(db);
    const code = await ensureReferralCode(db, referrer.id);
    const email = uniqueEmail("recruit");
    expect(await signup(testDeps(db), { email, displayName: "Recruit", password: "correct horse battery", referralCode: code })).toEqual({ ok: true });
    const recruit = await db.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    await markIdentityVerified(db, recruit.id);
    await db.storefront.create({
      data: {
        name: "Recruit Store",
        slug: `recruit-${randomUUID().slice(0, 8)}`,
        ownerUserId: recruit.id,
        stripeAccountId: `fake_acct_${randomUUID()}`,
        payoutsEnabled: true,
        members: { create: { userId: recruit.id, role: "OWNER" } },
      },
    });
    const { listingId } = await createLiveListing(db, { seller: recruit });
    const partner = await seller();

    const sale = await sellAndRelease(listingId, partner.user);
    const before = await db.referralEarning.findFirstOrThrow({ where: { orderId: sale } });
    expect(before.status).toBe("PENDING");
    await sellAndRelease(partner.listingId, recruit);

    await runCircleTradeScan({ db }, { force: true });
    expect(await signalsFor(sale)).toHaveLength(1);
    const after = await db.referralEarning.findFirstOrThrow({ where: { orderId: sale } });
    expect(after.status).toBe("FROZEN");
    expect(after.frozenReason).toMatch(/circle trade/);
  });

  it("flags an item whose photos come back to the account that sold it", async () => {
    const photos = testPhotos(2);
    const { seller: original, listingId } = await createLiveListing(db, { photos });
    const middle = await seller();
    const first = await sellAndRelease(listingId, middle.user);
    const { listingId: relisted } = await createLiveListing(db, { seller: middle.user, photos });
    const back = await sellAndRelease(relisted, original);

    await runCircleTradeScan({ db }, { force: true });
    const signals = await signalsFor(back);
    const returned = signals.find((s) => s.dedupeKey === `return:${first},${back}`);
    expect(returned).toBeDefined();
    expect(returned!.evidence).toMatchObject({ kind: "ITEM_RETURNED", earlierOwnerUserId: original.id });
  });
});

describe("appeals", () => {
  it("lets the member appeal once, and overturning lifts the action and emails them", async () => {
    const member = await createVerifiedUser(db);
    const other = await createVerifiedUser(db);
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const staff = await createVerifiedUser(db, { role: "MODERATOR" });
    const identity = testDeps(db);
    const warned = await takeEnforcementAction(identity, { actorId: staff.id, userId: member.id, type: "WARNING", reason: "Listing photos copied from another seller." });
    if (!warned.ok) throw new Error(warned.reason);
    const enforcementActionId = warned.enforcementId;

    expect(await submitAppeal({ db }, { userId: member.id, enforcementActionId, message: "too short" })).toEqual({ ok: false, reason: "MESSAGE_LENGTH" });
    expect(await submitAppeal({ db }, { userId: other.id, enforcementActionId, message: "These photos are mine, here is the original file." })).toEqual({
      ok: false,
      reason: "NOT_FOUND",
    });
    await expect(db.appeal.create({ data: { enforcementActionId, userId: other.id, message: "Inserted directly for someone else." } })).rejects.toThrow(
      /Only the member/,
    );
    const submitted = await submitAppeal({ db }, { userId: member.id, enforcementActionId, message: "These photos are mine, I took them in 2019." });
    if (!submitted.ok) throw new Error(submitted.reason);
    expect(await submitAppeal({ db }, { userId: member.id, enforcementActionId, message: "Appealing a second time for the same thing." })).toEqual({
      ok: false,
      reason: "ALREADY_APPEALED",
    });

    expect(await decideAppeal(identity, { actorId: member.id, appealId: submitted.appealId, decision: "OVERTURN", notes: "Looks fine to me." })).toEqual({
      ok: false,
      reason: "NOT_STAFF",
    });
    expect(await decideAppeal(identity, { actorId: owner.id, appealId: submitted.appealId, decision: "OVERTURN", notes: "Original files check out." })).toEqual({ ok: true });

    const action = await db.enforcementAction.findUniqueOrThrow({ where: { id: enforcementActionId }, include: { appeal: true } });
    expect(action.liftedAt).not.toBeNull();
    expect(action.liftReason).toMatch(/Appeal overturned/);
    expect(action.appeal?.status).toBe("OVERTURNED");
    expect(identity.mailer.sent.at(-1)).toMatchObject({ to: member.email, subject: "Your Used Artifacts appeal was reviewed" });

    expect(await decideAppeal(identity, { actorId: staff.id, appealId: submitted.appealId, decision: "UPHOLD", notes: "Changed my mind." })).toEqual({
      ok: false,
      reason: "ALREADY_DECIDED",
    });
    await expect(db.appeal.update({ where: { id: submitted.appealId }, data: { status: "UPHELD" } })).rejects.toThrow(/already decided/);
  });

  it("upholds without lifting, and moderators can't overturn a suspension", async () => {
    const member = await createVerifiedUser(db);
    const staff = await createVerifiedUser(db, { role: "MODERATOR" });
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    const identity = testDeps(db);
    const warned = await takeEnforcementAction(identity, { actorId: staff.id, userId: member.id, type: "WARNING", reason: "Repeated late shipping on orders." });
    if (!warned.ok) throw new Error(warned.reason);
    const appeal = await submitAppeal({ db }, { userId: member.id, enforcementActionId: warned.enforcementId, message: "The carrier lost both packages, not me." });
    if (!appeal.ok) throw new Error(appeal.reason);
    expect(await decideAppeal(identity, { actorId: staff.id, appealId: appeal.appealId, decision: "UPHOLD", notes: "Tracking shows no scans." })).toEqual({ ok: true });
    expect((await db.enforcementAction.findUniqueOrThrow({ where: { id: warned.enforcementId } })).liftedAt).toBeNull();

    const suspended = await takeEnforcementAction(identity, {
      actorId: owner.id,
      userId: member.id,
      type: "SUSPENSION",
      reason: "Non-delivery pattern.",
      suspensionDays: 7,
    });
    if (!suspended.ok) throw new Error(suspended.reason);
    const appeal2 = await submitAppeal({ db }, { userId: member.id, enforcementActionId: suspended.enforcementId, message: "Please look at the tracking again." });
    if (!appeal2.ok) throw new Error(appeal2.reason);
    expect(await decideAppeal(identity, { actorId: staff.id, appealId: appeal2.appealId, decision: "OVERTURN", notes: "Seems unfair." })).toEqual({
      ok: false,
      reason: "OWNER_ONLY",
    });
    expect((await db.appeal.findUniqueOrThrow({ where: { id: appeal2.appealId } })).status).toBe("OPEN");
  });
});
