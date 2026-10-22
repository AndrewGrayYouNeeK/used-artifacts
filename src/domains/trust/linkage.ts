import type { Db } from "@/lib/db";
import type { AccountLinkSignal } from "@/generated/prisma/enums";
import { writeAuditEvent, type Tx } from "@/domains/audit/audit";

/**
 * Signals strong enough to treat two accounts as the same person or household
 * for self-buy and self-bid blocking (BUILD_PLAN 5.3). SAME_IP alone is not.
 */
export const STRONG_SIGNALS = [
  "SAME_ID_HASH_ATTEMPT",
  "SAME_PERSON_DETAILS",
  "SAME_DEVICE",
  "SAME_PAYMENT_FINGERPRINT",
  "SAME_BANK",
  "SAME_SHIPPING_ADDRESS",
] as const satisfies AccountLinkSignal[];

const STRENGTH: Record<AccountLinkSignal, number> = {
  SAME_ID_HASH_ATTEMPT: 100,
  SAME_PAYMENT_FINGERPRINT: 90,
  SAME_BANK: 90,
  SAME_PERSON_DETAILS: 80,
  SAME_DEVICE: 70,
  SAME_SHIPPING_ADDRESS: 60,
  SAME_IP: 20,
};

export async function upsertLink(tx: Tx, userId: string, otherUserId: string, signal: AccountLinkSignal) {
  if (userId === otherUserId) return false;
  const [userAId, userBId] = [userId, otherUserId].sort();
  const existing = await tx.accountLink.findUnique({
    where: { userAId_userBId_signal: { userAId, userBId, signal } },
    select: { id: true },
  });
  if (existing) return false;
  await tx.accountLink.create({ data: { userAId, userBId, signal, strength: STRENGTH[signal] } });
  await writeAuditEvent(tx, {
    actorType: "SYSTEM",
    action: "trust.account_linked",
    subjectType: "User",
    subjectId: userId,
    after: { otherUserId, signal },
  });
  return true;
}

export async function linkByDevice(tx: Tx, userId: string, deviceIdHash: string) {
  const others = await tx.loginEvent.findMany({
    where: { deviceIdHash, userId: { not: userId }, succeeded: true },
    distinct: ["userId"],
    select: { userId: true },
  });
  for (const o of others) await upsertLink(tx, userId, o.userId, "SAME_DEVICE");
}

export async function linkByPaymentFingerprint(tx: Tx, userId: string, fingerprintHash: string) {
  const others = await tx.payment.findMany({
    where: { paymentFingerprintHash: fingerprintHash, order: { buyerUserId: { not: userId } } },
    select: { order: { select: { buyerUserId: true } } },
  });
  for (const id of new Set(others.map((o) => o.order.buyerUserId))) {
    await upsertLink(tx, userId, id, "SAME_PAYMENT_FINGERPRINT");
  }
}

export async function linkByShippingAddress(tx: Tx, userId: string, addressHash: string) {
  const others = await tx.order.findMany({
    where: { shippingAddressHash: addressHash, buyerUserId: { not: userId } },
    distinct: ["buyerUserId"],
    select: { buyerUserId: true },
  });
  for (const o of others) await upsertLink(tx, userId, o.buyerUserId, "SAME_SHIPPING_ADDRESS");
}

/** Strong links between two specific users. */
export async function strongLinksBetween(db: Db | Tx, a: string, b: string): Promise<AccountLinkSignal[]> {
  const [userAId, userBId] = [a, b].sort();
  const links = await db.accountLink.findMany({
    where: { userAId, userBId, signal: { in: [...STRONG_SIGNALS] } },
    select: { signal: true },
  });
  return links.map((l) => l.signal);
}

/** Every account strongly linked to this one. */
export async function stronglyLinkedUserIds(db: Db | Tx, userId: string): Promise<string[]> {
  const links = await db.accountLink.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }], signal: { in: [...STRONG_SIGNALS] } },
    select: { userAId: true, userBId: true },
  });
  return [...new Set(links.map((l) => (l.userAId === userId ? l.userBId : l.userAId)))];
}

export type SelfDealCheck =
  | { ok: true }
  | { ok: false; reason: "OWN_LISTING" | "STOREFRONT_MEMBER" }
  | { ok: false; reason: "LINKED_ACCOUNT"; signals: AccountLinkSignal[] };

/** Blocks buying (or bidding on) your own items, directly or through a linked account. */
export async function checkSelfDealing(
  db: Db | Tx,
  input: { buyerUserId: string; sellerUserId: string; storefrontId: string },
): Promise<SelfDealCheck> {
  if (input.buyerUserId === input.sellerUserId) return { ok: false, reason: "OWN_LISTING" };
  const member = await db.storefrontMember.findUnique({
    where: { storefrontId_userId: { storefrontId: input.storefrontId, userId: input.buyerUserId } },
  });
  if (member) return { ok: false, reason: "STOREFRONT_MEMBER" };
  const signals = await strongLinksBetween(db, input.buyerUserId, input.sellerUserId);
  if (signals.length > 0) return { ok: false, reason: "LINKED_ACCOUNT", signals };
  return { ok: true };
}

export async function raiseFraudSignal(
  tx: Tx,
  input: {
    detector: "SELF_BUY" | "SHILL" | "CIRCLE_TRADE" | "SELF_RESALE" | "RETRACTION_ABUSE" | "NONPAY";
    subjectType: string;
    subjectId: string;
    score: number;
    evidence: Record<string, unknown>;
  },
) {
  const signal = await tx.fraudSignal.create({
    data: {
      detector: input.detector,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      score: input.score,
      evidence: JSON.parse(JSON.stringify(input.evidence)),
    },
  });
  await writeAuditEvent(tx, {
    actorType: "SYSTEM",
    action: "fraud.signal_created",
    subjectType: "FraudSignal",
    subjectId: signal.id,
    after: { detector: input.detector, subjectType: input.subjectType, subjectId: input.subjectId, score: input.score },
  });
  return signal;
}
