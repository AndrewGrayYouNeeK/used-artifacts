import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createLiveListing, createVerifiedUser, markIdentityVerified, testDb, testDeps, uniqueEmail } from "../../../test/helpers";
import { economics } from "@/config/economics";
import { platform } from "@/config/platform";
import { takeEnforcementAction } from "@/domains/admin/enforcement";
import { signup } from "@/domains/identity/accounts";
import { FakePaymentsProvider, fakeCheckoutCompleted } from "@/domains/payments/fake-provider";
import { creditBalance } from "@/domains/payments/ledger";
import { startCheckout } from "@/domains/orders/checkout";
import type { OrdersDeps } from "@/domains/orders/deps";
import { confirmReceipt, markShipped } from "@/domains/orders/fulfillment";
import { processPaymentEvent } from "@/domains/orders/payment-events";
import { upsertLink } from "@/domains/trust/linkage";
import { awardBetaFounder, recomputeVolumeBadges, BETA_FOUNDER_CODE } from "./badges";
import { decideFrozenEarning, ensureReferralCode, runReferralJobs } from "./referrals";

const db = testDb();
afterAll(() => db.$disconnect());

const DAY = 24 * 60 * 60 * 1000;
const address = { name: "Bea Buyer", line1: "1 Main St", city: "Louisville", state: "KY", postalCode: "40202", country: "US" };

function makeDeps(now?: () => Date): OrdersDeps & { payments: FakePaymentsProvider } {
  return { db, payments: new FakePaymentsProvider("http://test.local"), appUrl: "http://test.local", linkageSecret: "x".repeat(32), now };
}

/** A referrer and a recruit who signed up with the referrer's code and has a live listing. */
async function referredSeller(opts: { askingPrice?: number } = {}) {
  const referrer = await createVerifiedUser(db);
  const code = await ensureReferralCode(db, referrer.id);
  const email = uniqueEmail("recruit");
  expect(await signup(testDeps(db), { email, displayName: "Recruit", password: "correct horse battery", referralCode: code.toLowerCase() })).toEqual({ ok: true });
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
  const { listingId } = await createLiveListing(db, { seller: recruit, askingPrice: opts.askingPrice ?? 10_000 });
  return { referrer, recruit, listingId };
}

/** Buys, pays, ships, and confirms receipt (release). */
async function sellAndRelease(deps: OrdersDeps, listingId: string, buyer: { id: string }, card = `card_${randomUUID()}`) {
  const checkout = await startCheckout(deps, { buyerUserId: buyer.id, buyerEmail: "b@example.com", listingId });
  if (!checkout.ok) throw new Error(checkout.reason);
  const payment = await db.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });
  const event = fakeCheckoutCompleted({
    checkoutSessionId: payment.checkoutSessionId,
    amountCents: payment.amountCents,
    taxCents: 0,
    shippingAddress: address,
    paymentFingerprint: card,
  });
  await processPaymentEvent(deps, event);
  const order = await db.order.findUniqueOrThrow({ where: { id: checkout.orderId } });
  await markShipped(deps, { sellerUserId: order.sellerUserId, orderId: order.id, carrier: "USPS", trackingNumber: "9400111899223197428490" });
  expect(await confirmReceipt(deps, { buyerUserId: buyer.id, orderId: order.id })).toEqual({ ok: true });
  return { orderId: order.id, chargeId: event.chargeId };
}

describe("referral attribution", () => {
  it("links a signup to the referrer's code and ignores unknown codes", async () => {
    const { referrer, recruit } = await referredSeller();
    const referral = await db.referral.findUniqueOrThrow({ where: { refereeUserId: recruit.id } });
    expect(referral.referrerUserId).toBe(referrer.id);

    const email = uniqueEmail("nobody");
    await signup(testDeps(db), { email, displayName: "Nobody", password: "correct horse battery", referralCode: "ZZZZZZZZ" });
    const nobody = await db.user.findUniqueOrThrow({ where: { email } });
    expect(await db.referral.count({ where: { refereeUserId: nobody.id } })).toBe(0);

    await expect(db.referral.update({ where: { id: referral.id }, data: { referrerUserId: nobody.id } })).rejects.toThrow(/immutable/);
    await expect(db.referral.delete({ where: { id: referral.id } })).rejects.toThrow();
  });
});

describe("referral earnings", () => {
  it("accrues 5% of the buyer price from the platform fee on release, then pays after the hold", async () => {
    const start = Date.now();
    let now = start;
    const deps = makeDeps(() => new Date(now));
    const { referrer, listingId } = await referredSeller({ askingPrice: 10_000 });
    const buyer = await createVerifiedUser(db);
    const { orderId } = await sellAndRelease(deps, listingId, buyer);

    const earning = await db.referralEarning.findFirstOrThrow({ where: { orderId } });
    expect(earning).toMatchObject({ status: "PENDING", basis: "BUYER_PRICE", basisCents: 11_000, rateBps: 500, amountCents: 550, platformFeeCents: 2_000, cappedAtFee: false });
    expect(earning.payableAt.getTime()).toBe(start + economics.referralHoldDays * DAY);
    expect(await creditBalance(db, `referral_payable:${referrer.id}`)).toBe(550);
    expect(await db.referral.findFirstOrThrow({ where: { referrerUserId: referrer.id } })).toMatchObject({ firstSaleOrderId: orderId });

    now = start + (economics.referralHoldDays + 1) * DAY;
    const minimum = { ...economics, referralMinPayoutCents: 500 };
    const notVerified = await runReferralJobs({ ...deps, economics: minimum });
    expect(notVerified.payoutsCreated).toBe(0);
    expect(await db.referralEarning.findUniqueOrThrow({ where: { id: earning.id } })).toMatchObject({ status: "PAYABLE" });

    await markIdentityVerified(db, referrer.id);
    await db.storefront.create({
      data: { name: "Referrer", slug: `ref-${randomUUID().slice(0, 8)}`, ownerUserId: referrer.id, stripeAccountId: `fake_acct_${randomUUID()}`, payoutsEnabled: true },
    });
    expect(await runReferralJobs({ ...deps, economics: { ...economics, referralMinPayoutCents: 1_000 } })).toMatchObject({ payoutsCreated: 0 });
    expect(await runReferralJobs({ ...deps, economics: minimum })).toMatchObject({ payoutsCreated: 1, payoutsPaid: 1 });
    expect(await db.referralEarning.findUniqueOrThrow({ where: { id: earning.id } })).toMatchObject({ status: "PAID" });
    expect(await creditBalance(db, `referral_payable:${referrer.id}`)).toBe(0);
    const transfer = deps.payments.transfers.at(-1)!;
    expect(transfer).toMatchObject({ amountCents: 550 });
    expect(transfer).not.toHaveProperty("sourceChargeId");

    await expect(db.referralEarning.update({ where: { id: earning.id }, data: { status: "PENDING" } })).rejects.toThrow(/final/);
    await expect(db.referralEarning.update({ where: { id: earning.id }, data: { amountCents: 1 } })).rejects.toThrow(/immutable/);
  });

  it("never pays more than the fees collected when the cap is on", async () => {
    const deps = { ...makeDeps(), economics: { ...economics, referralBps: 5_000 } };
    const { listingId } = await referredSeller({ askingPrice: 10_000 });
    const { orderId } = await sellAndRelease(deps, listingId, await createVerifiedUser(db));
    expect(await db.referralEarning.findFirstOrThrow({ where: { orderId } })).toMatchObject({ amountCents: 2_000, cappedAtFee: true });
  });

  it("freezes an earning when the referrer is linked to the buyer, and staff can forfeit it", async () => {
    const deps = makeDeps();
    const { referrer, listingId } = await referredSeller();
    const buyer = await createVerifiedUser(db);
    await db.$transaction((tx) => upsertLink(tx, buyer.id, referrer.id, "SAME_DEVICE"));
    const { orderId } = await sellAndRelease(deps, listingId, buyer);

    const earning = await db.referralEarning.findFirstOrThrow({ where: { orderId } });
    expect(earning.status).toBe("FROZEN");
    expect(earning.frozenReason).toMatch(/linked to the referrer/);
    expect(await db.fraudSignal.count({ where: { subjectType: "Order", subjectId: orderId, detector: "REFERRAL_ABUSE" } })).toBe(1);

    const mod = await createVerifiedUser(db, { role: "MODERATOR" });
    const idDeps = testDeps(db);
    expect(await decideFrozenEarning(idDeps, { actorId: mod.id, earningId: earning.id, decision: "FORFEIT", reason: "Referrer bought through a second account" })).toEqual({ ok: true });
    expect(await db.referralEarning.findUniqueOrThrow({ where: { id: earning.id } })).toMatchObject({ status: "CLAWED_BACK" });
    expect(await creditBalance(db, `referral_payable:${referrer.id}`)).toBe(0);
    expect(await db.enforcementAction.count({ where: { userId: referrer.id, type: "FEE_FORFEIT" } })).toBe(1);
    expect(idDeps.mailer.sent.at(-1)?.subject).toMatch(/forfeited/);
  });

  it("lets staff release a frozen earning back to the normal schedule", async () => {
    const deps = makeDeps();
    const { referrer, listingId } = await referredSeller();
    const { orderId } = await sellAndRelease(deps, listingId, referrer);
    const earning = await db.referralEarning.findFirstOrThrow({ where: { orderId } });
    expect(earning).toMatchObject({ status: "FROZEN", frozenReason: expect.stringMatching(/referrer bought/) });
    const mod = await createVerifiedUser(db, { role: "MODERATOR" });
    expect(await decideFrozenEarning(testDeps(db), { actorId: mod.id, earningId: earning.id, decision: "RELEASE", reason: "Gift purchase, verified by phone" })).toEqual({ ok: true });
    expect(await db.referralEarning.findUniqueOrThrow({ where: { id: earning.id } })).toMatchObject({ status: "PENDING" });
  });

  it("claws back an unpaid earning on a chargeback after release", async () => {
    const deps = makeDeps();
    const { referrer, listingId } = await referredSeller();
    const { orderId, chargeId } = await sellAndRelease(deps, listingId, await createVerifiedUser(db));
    await processPaymentEvent(deps, { eventId: `evt_${randomUUID()}`, kind: "CHARGE_DISPUTED", chargeId, reason: "fraudulent" });
    expect(await db.referralEarning.findFirstOrThrow({ where: { orderId } })).toMatchObject({ status: "CLAWED_BACK", clawbackReason: "Card chargeback after release" });
    expect(await creditBalance(db, `referral_payable:${referrer.id}`)).toBe(0);
  });

  it("forfeits unpaid earnings when the referrer is banned", async () => {
    const deps = makeDeps();
    const { referrer, listingId } = await referredSeller();
    const { orderId } = await sellAndRelease(deps, listingId, await createVerifiedUser(db));
    const owner = await createVerifiedUser(db, { role: "OWNER" });
    await takeEnforcementAction(testDeps(db), { actorId: owner.id, userId: referrer.id, type: "BAN", reason: "Recruiting fake sellers" });
    expect(await db.referralEarning.findFirstOrThrow({ where: { orderId } })).toMatchObject({ status: "CLAWED_BACK", clawbackReason: "Account banned" });
  });
});

describe("badges", () => {
  it("awards First Sale on release and counts only clean sales, capped per buyer", async () => {
    const deps = makeDeps();
    const { seller, listingId } = await createLiveListing(db);
    const buyer = await createVerifiedUser(db);
    await sellAndRelease(deps, listingId, buyer);
    const firstSale = await db.badge.findUniqueOrThrow({ where: { code: "FIRST_SALE" } });
    expect(await db.userBadge.findUnique({ where: { userId_badgeId: { userId: seller.id, badgeId: firstSale.id } } })).toMatchObject({ revokedAt: null });

    const strict = { ...platform, badgeMaxSalesPerCounterparty: 1 };
    const established = await db.badge.findUniqueOrThrow({ where: { code: "ESTABLISHED_SELLER" } });
    await db.badge.update({ where: { id: established.id }, data: { criteria: { releasedSalesCount: 2 } } });
    try {
      const second = await createLiveListing(db, { seller });
      await sellAndRelease(deps, second.listingId, buyer);
      expect(await db.$transaction((tx) => recomputeVolumeBadges(tx, seller.id, { config: strict }))).toEqual({ awarded: [], revoked: ["ESTABLISHED_SELLER"] });

      await db.$transaction((tx) => recomputeVolumeBadges(tx, seller.id, { config: { ...platform, badgeMaxSalesPerCounterparty: 3 } }));
      const award = await db.userBadge.findUniqueOrThrow({ where: { userId_badgeId: { userId: seller.id, badgeId: established.id } } });
      expect(award.revokedAt).toBeNull();

      await db.$transaction((tx) => upsertLink(tx, seller.id, buyer.id, "SAME_PAYMENT_FINGERPRINT"));
      expect(await db.$transaction((tx) => recomputeVolumeBadges(tx, seller.id))).toMatchObject({ revoked: expect.arrayContaining(["ESTABLISHED_SELLER", "FIRST_SALE"]) });
    } finally {
      await db.badge.update({ where: { id: established.id }, data: { criteria: { releasedSalesCount: 10 } } });
    }
  });

  it("doesn't re-award a badge that staff revoked until the revocation is lifted", async () => {
    const deps = makeDeps();
    const { seller, listingId } = await createLiveListing(db);
    await sellAndRelease(deps, listingId, await createVerifiedUser(db));
    const firstSale = await db.badge.findUniqueOrThrow({ where: { code: "FIRST_SALE" } });
    const award = await db.userBadge.findUniqueOrThrow({ where: { userId_badgeId: { userId: seller.id, badgeId: firstSale.id } } });
    const mod = await createVerifiedUser(db, { role: "MODERATOR" });
    await takeEnforcementAction(testDeps(db), { actorId: mod.id, userId: seller.id, type: "BADGE_REVOKED", reason: "Sales were to friends", userBadgeId: award.id });
    expect(await db.$transaction((tx) => recomputeVolumeBadges(tx, seller.id))).toEqual({ awarded: [], revoked: [] });
    expect((await db.userBadge.findUniqueOrThrow({ where: { id: award.id } })).revokedAt).not.toBeNull();
    await expect(db.userBadge.delete({ where: { id: award.id } })).rejects.toThrow(/cannot be deleted/);
  });

  it("caps Beta Founder in the app and in the database", async () => {
    const badge = await db.badge.findUniqueOrThrow({ where: { code: BETA_FOUNDER_CODE } });
    const awarded = await db.userBadge.count({ where: { badgeId: badge.id } });
    const user = await createVerifiedUser(db);
    expect(await db.$transaction((tx) => awardBetaFounder(tx, user.id, { config: { ...platform, betaFounderLimit: awarded } }))).toBe(false);

    await db.badge.update({ where: { id: badge.id }, data: { criteria: { firstNSellers: awarded } } });
    try {
      await expect(db.userBadge.create({ data: { userId: user.id, badgeId: badge.id } })).rejects.toThrow(/Beta Founder/);
    } finally {
      await db.badge.update({ where: { id: badge.id }, data: { criteria: { firstNSellers: 100 } } });
    }
    if (awarded < 100) {
      expect(await db.$transaction((tx) => awardBetaFounder(tx, user.id))).toBe(true);
      expect(await db.$transaction((tx) => awardBetaFounder(tx, user.id))).toBe(false);
    }
  });
});
