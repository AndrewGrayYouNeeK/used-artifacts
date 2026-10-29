import { z } from "zod";
import { writeAuditEvent } from "@/domains/audit/audit";
import type { RequestContext } from "@/domains/identity/accounts";
import { clock, DAY_MS, econ, manualTracker, type OrdersDeps } from "./deps";
import { executeRefund, executeTransfer, queueRefund, refundInFull, releaseFunds, sellerShareCents, transition } from "./escrow";

export const CARRIERS = ["USPS", "UPS", "FedEx", "DHL"] as const;

export const ShipmentSchema = z.object({
  carrier: z.enum(CARRIERS, { error: "Choose a carrier." }),
  trackingNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{8,40}$/, { error: "Enter the tracking number (8–40 letters and digits)." }),
});

export type MarkShippedResult = { ok: true } | { ok: false; reason: "NOT_FOUND" | "NOT_SHIPPABLE" };

export async function markShipped(
  deps: OrdersDeps,
  input: { sellerUserId: string; orderId: string; carrier: string; trackingNumber: string },
  ctx: RequestContext = {},
): Promise<MarkShippedResult> {
  const order = await deps.db.order.findUnique({ where: { id: input.orderId } });
  if (!order || order.sellerUserId !== input.sellerUserId) return { ok: false, reason: "NOT_FOUND" };
  if (order.status !== "PAID_HELD") return { ok: false, reason: "NOT_SHIPPABLE" };
  const { trackerId } = await (deps.tracker ?? manualTracker).register({
    carrier: input.carrier,
    trackingNumber: input.trackingNumber,
  });
  const now = clock(deps);
  await deps.db.$transaction(async (tx) => {
    await transition(tx, order, "SELLER_SHIPPED", { shippedAt: now });
    await tx.shipment.create({
      data: {
        orderId: order.id,
        carrier: input.carrier,
        trackingNumber: input.trackingNumber,
        trackerId,
        status: "IN_TRANSIT",
        shippedAt: now,
      },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.sellerUserId,
      actorType: "USER",
      action: "order.shipped",
      subjectType: "Order",
      subjectId: order.id,
      after: { carrier: input.carrier, trackingNumber: input.trackingNumber, tracked: trackerId !== null },
      ipHash: ctx.ipHash,
    });
  });
  return { ok: true };
}

export type DeliverySource = "CARRIER" | "STAFF";

/**
 * Carrier-confirmed (or staff-confirmed) delivery starts the hold period;
 * funds auto-release ESCROW_AUTO_RELEASE_DAYS later unless the buyer disputes.
 */
export async function recordDelivery(
  deps: OrdersDeps,
  input: { orderId: string; deliveredAt: Date; source: DeliverySource; actorUserId?: string },
): Promise<{ ok: true; releaseEligibleAt: Date } | { ok: false; reason: "NOT_FOUND" | "NOT_IN_TRANSIT" }> {
  const order = await deps.db.order.findUnique({ where: { id: input.orderId } });
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  if (order.status !== "SHIPPED") return { ok: false, reason: "NOT_IN_TRANSIT" };
  const releaseEligibleAt = new Date(input.deliveredAt.getTime() + econ(deps).escrowAutoReleaseDays * DAY_MS);
  await deps.db.$transaction(async (tx) => {
    await transition(tx, order, "CARRIER_DELIVERED", { deliveredAt: input.deliveredAt, releaseEligibleAt });
    await tx.shipment.update({
      where: { orderId: order.id },
      data: { status: "DELIVERED", deliveredAt: input.deliveredAt, deliverySource: input.source },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.actorUserId ?? null,
      actorType: input.source === "CARRIER" ? "WEBHOOK" : "ADMIN",
      action: "order.delivered",
      subjectType: "Order",
      subjectId: order.id,
      after: { deliveredAt: input.deliveredAt.toISOString(), source: input.source, releaseEligibleAt: releaseEligibleAt.toISOString() },
    });
  });
  return { ok: true, releaseEligibleAt };
}

/** Tracking webhook entry point: finds the in-transit shipment by tracking number. */
export async function recordCarrierDelivered(
  deps: OrdersDeps,
  input: { trackingNumber: string; deliveredAt: Date },
): Promise<{ matched: boolean }> {
  const shipment = await deps.db.shipment.findFirst({
    where: { trackingNumber: input.trackingNumber.toUpperCase(), order: { status: "SHIPPED" } },
  });
  if (!shipment) return { matched: false };
  const result = await recordDelivery(deps, { orderId: shipment.orderId, deliveredAt: input.deliveredAt, source: "CARRIER" });
  return { matched: result.ok };
}

export type ConfirmReceiptResult =
  | { ok: true }
  | { ok: false; reason: "NOT_FOUND" | "NOT_CONFIRMABLE" | "ON_HOLD" };

/** The buyer says the item arrived as described: funds release to the seller now. */
export async function confirmReceipt(
  deps: OrdersDeps,
  input: { buyerUserId: string; orderId: string },
  ctx: RequestContext = {},
): Promise<ConfirmReceiptResult> {
  const order = await deps.db.order.findUnique({ where: { id: input.orderId } });
  if (!order || order.buyerUserId !== input.buyerUserId) return { ok: false, reason: "NOT_FOUND" };
  if (order.status !== "SHIPPED" && order.status !== "DELIVERED") return { ok: false, reason: "NOT_CONFIRMABLE" };
  if (order.releaseHold) return { ok: false, reason: "ON_HOLD" };
  const now = clock(deps);
  const { transferId } = await deps.db.$transaction(async (tx) => {
    if (order.status === "SHIPPED") {
      await tx.shipment.update({
        where: { orderId: order.id },
        data: { status: "DELIVERED", deliveredAt: now, deliverySource: "BUYER" },
      });
      await tx.order.update({ where: { id: order.id }, data: { deliveredAt: now } });
    }
    return releaseFunds(tx, deps, order, "BUYER_CONFIRMED", {
      actorUserId: input.buyerUserId,
      actorType: "USER",
      ipHash: ctx.ipHash,
    });
  });
  if (transferId) await executeTransfer(deps, transferId);
  return { ok: true };
}

export const DisputeSchema = z.object({
  reason: z.string().trim().min(20, { error: "Describe the problem in at least 20 characters." }).max(2000),
});

export type OpenDisputeResult = { ok: true; disputeId: string } | { ok: false; reason: "NOT_FOUND" | "NOT_DISPUTABLE" };

export async function openDispute(
  deps: OrdersDeps,
  input: { buyerUserId: string; orderId: string; reason: string },
  ctx: RequestContext = {},
): Promise<OpenDisputeResult> {
  const order = await deps.db.order.findUnique({ where: { id: input.orderId } });
  if (!order || order.buyerUserId !== input.buyerUserId) return { ok: false, reason: "NOT_FOUND" };
  if (!["PAID_HELD", "SHIPPED", "DELIVERED"].includes(order.status)) return { ok: false, reason: "NOT_DISPUTABLE" };
  const dispute = await deps.db.$transaction(async (tx) => {
    await transition(tx, order, "DISPUTE_OPENED");
    const created = await tx.dispute.create({
      data: { orderId: order.id, openedById: input.buyerUserId, reason: input.reason, evidenceKeys: [] },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.buyerUserId,
      actorType: "USER",
      action: "order.dispute_opened",
      subjectType: "Dispute",
      subjectId: created.id,
      after: { orderId: order.id, fromStatus: order.status },
      ipHash: ctx.ipHash,
    });
    return created;
  });
  return { ok: true, disputeId: dispute.id };
}

export type ResolveDisputeResult =
  | { ok: true }
  | {
      ok: false;
      reason: "NOT_STAFF" | "NOT_FOUND" | "ALREADY_RESOLVED" | "PARTY_TO_ORDER" | "NOTES_REQUIRED" | "INVALID_REFUND";
    };

/**
 * Staff decision. RELEASE pays the seller in full; REFUND returns the whole
 * charge to the buyer; PARTIAL refunds part of the item price out of the
 * seller's share (platform fees are kept).
 */
export async function resolveDispute(
  deps: OrdersDeps,
  input: {
    staffUserId: string;
    disputeId: string;
    resolution: "RELEASE" | "REFUND" | "PARTIAL";
    refundCents?: number;
    notes: string;
  },
  ctx: RequestContext = {},
): Promise<ResolveDisputeResult> {
  const staff = await deps.db.user.findUnique({ where: { id: input.staffUserId }, select: { role: true } });
  if (!staff || (staff.role !== "OWNER" && staff.role !== "MODERATOR")) return { ok: false, reason: "NOT_STAFF" };
  const notes = input.notes.trim();
  if (notes.length < 5) return { ok: false, reason: "NOTES_REQUIRED" };
  const dispute = await deps.db.dispute.findUnique({ where: { id: input.disputeId }, include: { order: true } });
  if (!dispute) return { ok: false, reason: "NOT_FOUND" };
  const { order } = dispute;
  if (dispute.status === "RESOLVED" || order.status !== "DISPUTED") return { ok: false, reason: "ALREADY_RESOLVED" };
  if (order.buyerUserId === input.staffUserId || order.sellerUserId === input.staffUserId) {
    return { ok: false, reason: "PARTY_TO_ORDER" };
  }
  const refundCents = input.resolution === "PARTIAL" ? (input.refundCents ?? 0) : null;
  if (refundCents !== null && (!Number.isInteger(refundCents) || refundCents <= 0 || refundCents >= sellerShareCents(order))) {
    return { ok: false, reason: "INVALID_REFUND" };
  }

  const actor = { actorUserId: input.staffUserId, actorType: "ADMIN" as const, ipHash: ctx.ipHash };
  const pending = await deps.db.$transaction(async (tx) => {
    const updated = await tx.dispute.updateMany({
      where: { id: dispute.id, status: { not: "RESOLVED" } },
      data: {
        status: "RESOLVED",
        resolution: input.resolution,
        refundCents,
        resolvedById: input.staffUserId,
        resolutionNotes: notes,
        resolvedAt: clock(deps),
      },
    });
    if (updated.count !== 1) throw new Error("Dispute was resolved concurrently");
    await writeAuditEvent(tx, {
      ...actor,
      action: "order.dispute_resolved",
      subjectType: "Dispute",
      subjectId: dispute.id,
      after: { orderId: order.id, resolution: input.resolution, refundCents, notes },
    });
    switch (input.resolution) {
      case "RELEASE": {
        const { transferId } = await releaseFunds(tx, deps, order, "DISPUTE_RELEASE", actor);
        return { transferId, refundId: null };
      }
      case "REFUND": {
        const { refundId } = await refundInFull(tx, deps, order, "DISPUTE_REFUND", actor, "Dispute resolved for the buyer");
        return { transferId: null, refundId };
      }
      case "PARTIAL": {
        const { transferId } = await releaseFunds(tx, deps, order, "DISPUTE_PARTIAL", actor, refundCents!);
        const refundId = await queueRefund(tx, order, { amountCents: refundCents!, reason: "Partial refund (dispute)", key: "partial" });
        return { transferId, refundId };
      }
      default: {
        const exhaustive: never = input.resolution;
        throw new Error(`Unknown resolution: ${String(exhaustive)}`);
      }
    }
  });
  if (pending.refundId) await executeRefund(deps, pending.refundId);
  if (pending.transferId) await executeTransfer(deps, pending.transferId);
  return { ok: true };
}

export type CancelOrderResult = { ok: true } | { ok: false; reason: "NOT_FOUND" | "NOT_CANCELLABLE" };

/** The seller can't ship: the buyer gets everything back and the listing returns to sale. */
export async function cancelBySeller(
  deps: OrdersDeps,
  input: { sellerUserId: string; orderId: string; reason: string },
  ctx: RequestContext = {},
): Promise<CancelOrderResult> {
  const order = await deps.db.order.findUnique({ where: { id: input.orderId } });
  if (!order || order.sellerUserId !== input.sellerUserId) return { ok: false, reason: "NOT_FOUND" };
  if (order.status !== "PAID_HELD") return { ok: false, reason: "NOT_CANCELLABLE" };
  const { refundId } = await deps.db.$transaction((tx) =>
    refundInFull(
      tx,
      deps,
      order,
      "SELLER_CANCELLED",
      { actorUserId: input.sellerUserId, actorType: "USER", ipHash: ctx.ipHash },
      `Cancelled by seller: ${input.reason.trim().slice(0, 200) || "no reason given"}`,
    ),
  );
  await executeRefund(deps, refundId);
  return { ok: true };
}

/** Staff place or clear a fraud hold; held orders never auto-release. */
export async function setReleaseHold(
  deps: OrdersDeps,
  input: { staffUserId: string; orderId: string; hold: boolean; reason: string },
  ctx: RequestContext = {},
): Promise<{ ok: true } | { ok: false; reason: "NOT_STAFF" | "NOT_FOUND" | "NOTES_REQUIRED" }> {
  const staff = await deps.db.user.findUnique({ where: { id: input.staffUserId }, select: { role: true } });
  if (!staff || (staff.role !== "OWNER" && staff.role !== "MODERATOR")) return { ok: false, reason: "NOT_STAFF" };
  if (input.reason.trim().length < 5) return { ok: false, reason: "NOTES_REQUIRED" };
  const order = await deps.db.order.findUnique({ where: { id: input.orderId } });
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  await deps.db.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: { releaseHold: input.hold, releaseHoldReason: input.hold ? input.reason.trim() : null },
    });
    await writeAuditEvent(tx, {
      actorUserId: input.staffUserId,
      actorType: "ADMIN",
      action: input.hold ? "order.hold_placed" : "order.hold_cleared",
      subjectType: "Order",
      subjectId: order.id,
      before: { releaseHold: order.releaseHold, reason: order.releaseHoldReason },
      after: { releaseHold: input.hold, reason: input.reason.trim() },
      ipHash: ctx.ipHash,
    });
  });
  return { ok: true };
}
