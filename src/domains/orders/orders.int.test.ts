import { afterAll, describe, expect, it } from "vitest";
import { createLiveListing, createVerifiedUser, testDb } from "../../../test/helpers";
import { FakePaymentsProvider, fakeCheckoutCompleted } from "@/domains/payments/fake-provider";
import { creditBalance } from "@/domains/payments/ledger";
import { upsertLink } from "@/domains/trust/linkage";
import { allEdges } from "./state-machine";
import { startCheckout } from "./checkout";
import { processPaymentEvent } from "./payment-events";
import {
  cancelBySeller,
  confirmReceipt,
  markShipped,
  openDispute,
  recordDelivery,
  resolveDispute,
  setReleaseHold,
} from "./fulfillment";
import { runEscrowJobs } from "./jobs";
import type { OrdersDeps } from "./deps";

const db = testDb();
afterAll(() => db.$disconnect());

const DAY = 24 * 60 * 60 * 1000;

function makeDeps(now?: () => Date): OrdersDeps & { payments: FakePaymentsProvider } {
  return { db, payments: new FakePaymentsProvider("http://test.local"), appUrl: "http://test.local", linkageSecret: "x".repeat(32), now };
}

const address = { name: "Bea Buyer", line1: "1 Main St", city: "Louisville", state: "KY", postalCode: "40202", country: "US" };

async function buyAndPay(deps: OrdersDeps, opts: { askingPrice?: number; shipping?: number; card?: string } = {}) {
  const { seller, listingId } = await createLiveListing(db, { askingPrice: opts.askingPrice, shipping: opts.shipping });
  const buyer = await createVerifiedUser(db);
  const checkout = await startCheckout(deps, { buyerUserId: buyer.id, buyerEmail: "b@example.com", listingId });
  if (!checkout.ok) throw new Error(checkout.reason);
  const payment = await db.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });
  const event = fakeCheckoutCompleted({
    checkoutSessionId: payment.checkoutSessionId,
    amountCents: payment.amountCents,
    taxCents: 0,
    shippingAddress: address,
    paymentFingerprint: opts.card ?? `card_${checkout.orderId}`,
  });
  const paid = await processPaymentEvent(deps, event);
  return { seller, buyer, listingId, orderId: checkout.orderId, event, paid };
}

describe("checkout", () => {
  it("snapshots the two-sided fees and charges buyer price + shipping, no surcharge", async () => {
    const deps = makeDeps();
    const { seller, listingId } = await createLiveListing(db, { askingPrice: 10_000, shipping: 1_200 });
    const buyer = await createVerifiedUser(db);
    const result = await startCheckout(deps, { buyerUserId: buyer.id, buyerEmail: "b@example.com", listingId });
    if (!result.ok) throw new Error(result.reason);
    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId }, include: { payments: true } });
    expect(order).toMatchObject({
      sellerUserId: seller.id,
      status: "CREATED",
      askingPriceCents: 10_000,
      buyerPriceCents: 11_000,
      sellerPayoutCents: 9_000,
      platformFeeCents: 2_000,
      shippingCents: 1_200,
    });
    expect(order.payments[0].amountCents).toBe(12_200);
    expect(result.url).toContain(`/checkout/dev/${order.id}`);
  });

  it("holds the listing for one buyer at a time", async () => {
    const deps = makeDeps();
    const { listingId } = await createLiveListing(db);
    const [a, b] = [await createVerifiedUser(db), await createVerifiedUser(db)];
    expect((await startCheckout(deps, { buyerUserId: a.id, buyerEmail: "a@x.com", listingId })).ok).toBe(true);
    expect(await startCheckout(deps, { buyerUserId: b.id, buyerEmail: "b@x.com", listingId })).toEqual({
      ok: false,
      reason: "LISTING_RESERVED",
    });
    expect((await startCheckout(deps, { buyerUserId: a.id, buyerEmail: "a@x.com", listingId })).ok).toBe(true);
    expect(await db.order.count({ where: { listingId, status: "CREATED" } })).toBe(1);
  });

  it("needs the seller's payouts to be on", async () => {
    const deps = makeDeps();
    const { seller, listingId } = await createLiveListing(db);
    await db.storefront.updateMany({ where: { ownerUserId: seller.id }, data: { payoutsEnabled: false } });
    const buyer = await createVerifiedUser(db);
    expect(await startCheckout(deps, { buyerUserId: buyer.id, buyerEmail: "b@x.com", listingId })).toEqual({
      ok: false,
      reason: "SELLER_NOT_READY",
    });
  });

  it("blocks buying your own listing and from strongly linked accounts, with a fraud signal", async () => {
    const deps = makeDeps();
    const { seller, listingId } = await createLiveListing(db);
    expect(await startCheckout(deps, { buyerUserId: seller.id, buyerEmail: "s@x.com", listingId })).toEqual({
      ok: false,
      reason: "OWN_LISTING",
    });
    const alt = await createVerifiedUser(db);
    await db.$transaction((tx) => upsertLink(tx, alt.id, seller.id, "SAME_DEVICE"));
    expect(await startCheckout(deps, { buyerUserId: alt.id, buyerEmail: "alt@x.com", listingId })).toEqual({
      ok: false,
      reason: "SELF_DEALING",
    });
    const signal = await db.fraudSignal.findFirst({ where: { detector: "SELF_BUY", subjectId: alt.id } });
    expect(signal?.score).toBeGreaterThan(0);
  });

  it("links accounts that log in on the same device and blocks them", async () => {
    const deps = makeDeps();
    const { seller, listingId } = await createLiveListing(db);
    const alt = await createVerifiedUser(db);
    await db.loginEvent.create({ data: { userId: seller.id, succeeded: true, deviceIdHash: `dev_${listingId}` } });
    const result = await startCheckout(
      deps,
      { buyerUserId: alt.id, buyerEmail: "alt@x.com", listingId },
      { deviceIdHash: `dev_${listingId}` },
    );
    expect(result).toEqual({ ok: false, reason: "SELF_DEALING" });
  });
});

describe("payment and escrow", () => {
  it("holds funds on payment, marks the listing sold, and is idempotent per event", async () => {
    const deps = makeDeps();
    const { orderId, listingId, event, paid } = await buyAndPay(deps, { shipping: 800 });
    expect(paid).toEqual({ outcome: "PAID", orderId, held: false });
    expect(await processPaymentEvent(deps, event)).toEqual({ outcome: "DUPLICATE_EVENT" });
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PAID_HELD");
    expect(order.shippingAddressHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("SOLD");
    expect(await creditBalance(db, `buyer_held:${orderId}`)).toBe(11_800);
  });

  it("ship → carrier delivered → auto-release after the hold, with a transfer and balanced ledger", async () => {
    let now = new Date();
    const deps = makeDeps(() => now);
    const { seller, orderId, listingId } = await buyAndPay(deps, { askingPrice: 10_000, shipping: 800 });
    const revenueBefore = await creditBalance(db, "platform_revenue");

    expect(await markShipped(deps, { sellerUserId: seller.id, orderId, carrier: "USPS", trackingNumber: "9400111899223197428490" })).toEqual({ ok: true });
    const delivered = await recordDelivery(deps, { orderId, deliveredAt: now, source: "CARRIER" });
    if (!delivered.ok) throw new Error(delivered.reason);
    expect(delivered.releaseEligibleAt.getTime() - now.getTime()).toBe(3 * DAY);

    expect((await runEscrowJobs(deps)).autoReleased).toBe(0);
    now = new Date(now.getTime() + 3 * DAY + 1000);
    const report = await runEscrowJobs(deps);
    expect(report.autoReleased).toBeGreaterThanOrEqual(1);

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { transfers: true } });
    expect(order.status).toBe("AUTO_RELEASED");
    expect(order.transfers).toMatchObject([{ amountCents: 9_800, status: "PAID" }]);
    expect(deps.payments.transfers.find((t) => t.idempotencyKey === `order:${orderId}:release`)?.amountCents).toBe(9_800);
    expect(await creditBalance(db, `buyer_held:${orderId}`)).toBe(0);
    expect(await creditBalance(db, `seller_payable:${seller.id}`)).toBe(0);
    expect((await creditBalance(db, "platform_revenue")) - revenueBefore).toBe(2_000);
    const outcome = await db.listingOutcome.findUniqueOrThrow({ where: { listingId } });
    expect(outcome).toMatchObject({ outcome: "SOLD", salePriceCents: 11_000, photoCount: 1 });
  });

  it("buyer confirmation releases immediately, even before carrier delivery", async () => {
    const deps = makeDeps();
    const { seller, buyer, orderId } = await buyAndPay(deps);
    await markShipped(deps, { sellerUserId: seller.id, orderId, carrier: "UPS", trackingNumber: "1Z999AA10123456784" });
    expect(await confirmReceipt(deps, { buyerUserId: seller.id, orderId })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await confirmReceipt(deps, { buyerUserId: buyer.id, orderId })).toEqual({ ok: true });
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { shipment: true } });
    expect(order.status).toBe("RELEASED");
    expect(order.shipment?.deliverySource).toBe("BUYER");
    expect(await confirmReceipt(deps, { buyerUserId: buyer.id, orderId })).toEqual({ ok: false, reason: "NOT_CONFIRMABLE" });
  });

  it("a dispute resolved as a refund returns the whole charge and ends the listing", async () => {
    const deps = makeDeps();
    const { buyer, orderId, listingId } = await buyAndPay(deps, { shipping: 500 });
    const staff = await createVerifiedUser(db, { role: "MODERATOR" });
    const opened = await openDispute(deps, { buyerUserId: buyer.id, orderId, reason: "The seller never shipped and stopped replying." });
    if (!opened.ok) throw new Error(opened.reason);
    expect(await resolveDispute(deps, { staffUserId: staff.id, disputeId: opened.disputeId, resolution: "REFUND", notes: "" })).toEqual({
      ok: false,
      reason: "NOTES_REQUIRED",
    });
    expect(
      await resolveDispute(deps, { staffUserId: buyer.id, disputeId: opened.disputeId, resolution: "REFUND", notes: "self" }),
    ).toEqual({ ok: false, reason: "NOT_STAFF" });
    expect(
      await resolveDispute(deps, { staffUserId: staff.id, disputeId: opened.disputeId, resolution: "REFUND", notes: "No tracking provided." }),
    ).toEqual({ ok: true });
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { refunds: true, payments: true } });
    expect(order.status).toBe("RESOLVED_REFUND");
    expect(order.refunds).toMatchObject([{ amountCents: 11_500, status: "SUCCEEDED" }]);
    expect(order.payments[0].status).toBe("REFUNDED");
    expect(await creditBalance(db, `buyer_held:${orderId}`)).toBe(0);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("ENDED");
  });

  it("a partial resolution refunds part of the seller's share and releases the rest", async () => {
    const deps = makeDeps();
    const { seller, buyer, orderId } = await buyAndPay(deps, { askingPrice: 10_000 });
    const staff = await createVerifiedUser(db, { role: "OWNER" });
    await markShipped(deps, { sellerUserId: seller.id, orderId, carrier: "USPS", trackingNumber: "9400111899223197428491" });
    const opened = await openDispute(deps, { buyerUserId: buyer.id, orderId, reason: "Arrived with a chipped base not shown in photos." });
    if (!opened.ok) throw new Error(opened.reason);
    const base = { staffUserId: staff.id, disputeId: opened.disputeId, resolution: "PARTIAL" as const, notes: "Chip confirmed by photos." };
    expect(await resolveDispute(deps, { ...base, refundCents: 9_000 })).toEqual({ ok: false, reason: "INVALID_REFUND" });
    expect(await resolveDispute(deps, { ...base, refundCents: 2_000 })).toEqual({ ok: true });
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { transfers: true, refunds: true } });
    expect(order.status).toBe("RESOLVED_PARTIAL");
    expect(order.transfers[0].amountCents).toBe(7_000);
    expect(order.refunds[0].amountCents).toBe(2_000);
    expect(await creditBalance(db, `buyer_held:${orderId}`)).toBe(0);
  });

  it("seller cancellation refunds in full and puts the listing back on sale", async () => {
    const deps = makeDeps();
    const { seller, orderId, listingId } = await buyAndPay(deps);
    expect(await cancelBySeller(deps, { sellerUserId: seller.id, orderId, reason: "Broke while packing" })).toEqual({ ok: true });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("CANCELLED_REFUNDED");
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("LIVE");
    expect(await creditBalance(db, `buyer_held:${orderId}`)).toBe(0);
  });

  it("refunds orders the seller doesn't ship in time", async () => {
    let now = new Date();
    const deps = makeDeps(() => now);
    const { orderId } = await buyAndPay(deps);
    now = new Date(now.getTime() + 6 * DAY);
    await runEscrowJobs(deps);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { refunds: true } });
    expect(order.status).toBe("CANCELLED_REFUNDED");
    expect(order.refunds[0].status).toBe("SUCCEEDED");
  });

  it("refunds a payment that arrives after the checkout expired", async () => {
    let now = new Date();
    const deps = makeDeps(() => now);
    const { listingId } = await createLiveListing(db);
    const buyer = await createVerifiedUser(db);
    const checkout = await startCheckout(deps, { buyerUserId: buyer.id, buyerEmail: "b@x.com", listingId });
    if (!checkout.ok) throw new Error(checkout.reason);
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    expect((await runEscrowJobs(deps)).expired).toBeGreaterThanOrEqual(1);
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });
    const late = await processPaymentEvent(
      deps,
      fakeCheckoutCompleted({ checkoutSessionId: payment.checkoutSessionId, amountCents: 11_000, taxCents: 0, shippingAddress: address, paymentFingerprint: null }),
    );
    expect(late).toEqual({ outcome: "LATE_PAYMENT_REFUNDED", orderId: checkout.orderId });
    expect(await creditBalance(db, `buyer_held:${checkout.orderId}`)).toBe(0);
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe("LIVE");
  });

  it("holds funds when the card was used by an account linked to the seller", async () => {
    let now = new Date();
    const deps = makeDeps(() => now);
    const card = `card_shared_${Date.now()}`;
    const first = await buyAndPay(deps, { card });
    const staff = await createVerifiedUser(db, { role: "OWNER" });
    // The seller of the first sale pays for something with the same card...
    const { listingId } = await createLiveListing(db);
    const checkout = await startCheckout(deps, { buyerUserId: first.seller.id, buyerEmail: "s@x.com", listingId });
    if (!checkout.ok) throw new Error(checkout.reason);
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });
    await processPaymentEvent(
      deps,
      fakeCheckoutCompleted({ checkoutSessionId: payment.checkoutSessionId, amountCents: 11_000, taxCents: 0, shippingAddress: null, paymentFingerprint: card }),
    );
    // ...which links them to the first buyer, so a new purchase between them is held.
    const { listingId: second } = await createLiveListing(db, { seller: first.seller });
    expect(await startCheckout(deps, { buyerUserId: first.buyer.id, buyerEmail: "b@x.com", listingId: second })).toEqual({
      ok: false,
      reason: "SELF_DEALING",
    });

    await markShipped(deps, { sellerUserId: first.seller.id, orderId: first.orderId, carrier: "USPS", trackingNumber: "9400111899223197428492" });
    await db.order.update({ where: { id: first.orderId }, data: { releaseHold: true, releaseHoldReason: "test" } });
    await recordDelivery(deps, { orderId: first.orderId, deliveredAt: now, source: "STAFF" });
    expect(await confirmReceipt(deps, { buyerUserId: first.buyer.id, orderId: first.orderId })).toEqual({ ok: false, reason: "ON_HOLD" });
    now = new Date(now.getTime() + 4 * DAY);
    await runEscrowJobs(deps);
    expect((await db.order.findUniqueOrThrow({ where: { id: first.orderId } })).status).toBe("DELIVERED");
    await setReleaseHold(deps, { staffUserId: staff.id, orderId: first.orderId, hold: false, reason: "Reviewed: unrelated household" });
    await runEscrowJobs(deps);
    expect((await db.order.findUniqueOrThrow({ where: { id: first.orderId } })).status).toBe("AUTO_RELEASED");
  });

  it("retries a failed transfer until the provider accepts it, paying once", async () => {
    const deps = makeDeps();
    const { seller, buyer, orderId } = await buyAndPay(deps);
    await markShipped(deps, { sellerUserId: seller.id, orderId, carrier: "USPS", trackingNumber: "9400111899223197428493" });
    deps.payments.failTransfers = true;
    expect(await confirmReceipt(deps, { buyerUserId: buyer.id, orderId })).toEqual({ ok: true });
    let transfer = await db.transfer.findFirstOrThrow({ where: { orderId } });
    expect(transfer).toMatchObject({ status: "PENDING", attempts: 1 });
    deps.payments.failTransfers = false;
    await runEscrowJobs(deps);
    await runEscrowJobs(deps);
    transfer = await db.transfer.findFirstOrThrow({ where: { orderId } });
    expect(transfer.status).toBe("PAID");
    expect(deps.payments.transfers.filter((t) => t.idempotencyKey === transfer.idempotencyKey)).toHaveLength(1);
    expect(await creditBalance(db, `seller_payable:${seller.id}`)).toBe(0);
  });
});

describe("database guards", () => {
  it("the trigger allows exactly the state machine's edges", async () => {
    const deps = makeDeps();
    const { orderId } = await buyAndPay(deps);
    await expect(db.order.update({ where: { id: orderId }, data: { status: "RELEASED" } })).rejects.toThrow(/Illegal order status/);
    await expect(db.order.update({ where: { id: orderId }, data: { status: "AUTO_RELEASED" } })).rejects.toThrow();
    const rows = await db.$queryRaw<{ src: string }[]>`SELECT prosrc AS src FROM pg_proc WHERE proname = 'order_status_guard'`;
    for (const [from, to] of allEdges()) expect(rows[0].src).toContain(`('${from}', '${to}')`);
  });

  it("only one active order per listing, and ledger entries can't be edited", async () => {
    const deps = makeDeps();
    const { orderId } = await buyAndPay(deps);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    await expect(
      db.order.create({
        data: {
          listingId: order.listingId,
          buyerUserId: order.buyerUserId,
          sellerUserId: order.sellerUserId,
          storefrontId: order.storefrontId,
          source: order.source,
          askingPriceCents: order.askingPriceCents,
          buyerFeeBps: order.buyerFeeBps,
          buyerFeeCents: order.buyerFeeCents,
          buyerPriceCents: order.buyerPriceCents,
          sellerFeeBps: order.sellerFeeBps,
          sellerFeeCents: order.sellerFeeCents,
          sellerPayoutCents: order.sellerPayoutCents,
          platformFeeCents: order.platformFeeCents,
          status: "CREATED",
        },
      }),
    ).rejects.toThrow(/order_one_active_per_listing|Unique constraint/);
    const entry = await db.ledgerEntry.findFirstOrThrow({ where: { orderId } });
    await expect(db.ledgerEntry.update({ where: { id: entry.id }, data: { amountCents: 1 } })).rejects.toThrow(/immutable/);
    await expect(db.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/immutable/);
  });
});
