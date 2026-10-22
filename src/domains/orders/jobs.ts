import { writeAuditEvent } from "@/domains/audit/audit";
import { clock, DAY_MS, econ, type OrdersDeps } from "./deps";
import { executeRefund, executeTransfer, IllegalTransitionError, refundInFull, releaseFunds, transition } from "./escrow";

export interface EscrowJobReport {
  expired: number;
  cancelledUnshipped: number;
  autoReleased: number;
  transfersPaid: number;
  refundsSent: number;
}

const BATCH = 100;

/**
 * Time-driven escrow transitions, safe to run concurrently or repeatedly:
 * each order moves with a status precondition, and provider calls are
 * idempotent. Scheduled via /api/cron/escrow.
 */
export async function runEscrowJobs(deps: OrdersDeps): Promise<EscrowJobReport> {
  const now = clock(deps);
  const config = econ(deps);
  const report: EscrowJobReport = { expired: 0, cancelledUnshipped: 0, autoReleased: 0, transfersPaid: 0, refundsSent: 0 };
  const system = { actorType: "SYSTEM" as const };

  const unpaid = await deps.db.order.findMany({
    where: { status: "CREATED", paymentDueAt: { lte: now } },
    include: { payments: { select: { checkoutSessionId: true } } },
    take: BATCH,
  });
  for (const order of unpaid) {
    for (const p of order.payments) await deps.payments.expireCheckout(p.checkoutSessionId).catch(() => undefined);
    await skipRaces(async () => {
      await deps.db.$transaction(async (tx) => {
        await transition(tx, order, "PAYMENT_WINDOW_EXPIRED");
        await tx.payment.updateMany({ where: { orderId: order.id, status: "REQUIRES_PAYMENT" }, data: { status: "FAILED" } });
        await writeAuditEvent(tx, { ...system, action: "order.expired", subjectType: "Order", subjectId: order.id });
      });
      report.expired++;
    });
  }

  const unshipped = await deps.db.order.findMany({
    where: { status: "PAID_HELD", paidAt: { lte: new Date(now.getTime() - config.sellerShipByDays * DAY_MS) } },
    take: BATCH,
  });
  for (const order of unshipped) {
    await skipRaces(async () => {
      const { refundId } = await deps.db.$transaction((tx) =>
        refundInFull(tx, deps, order, "SHIP_DEADLINE_MISSED", system, `Not shipped within ${config.sellerShipByDays} days`),
      );
      await executeRefund(deps, refundId);
      report.cancelledUnshipped++;
    });
  }

  const due = await deps.db.order.findMany({
    where: { status: "DELIVERED", releaseHold: false, releaseEligibleAt: { lte: now } },
    take: BATCH,
  });
  for (const order of due) {
    await skipRaces(async () => {
      const { transferId } = await deps.db.$transaction((tx) => releaseFunds(tx, deps, order, "AUTO_RELEASE", system));
      if (transferId) await executeTransfer(deps, transferId);
      report.autoReleased++;
    });
  }

  const transfers = await deps.db.transfer.findMany({ where: { status: "PENDING" }, select: { id: true }, take: BATCH });
  for (const t of transfers) if (await executeTransfer(deps, t.id)) report.transfersPaid++;
  const refunds = await deps.db.refund.findMany({
    where: { status: { in: ["PENDING", "FAILED"] } },
    select: { id: true },
    take: BATCH,
  });
  for (const r of refunds) if (await executeRefund(deps, r.id)) report.refundsSent++;
  return report;
}

/** Another request moved the order first; the next run sees the new state. */
async function skipRaces(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof IllegalTransitionError) return;
    throw err;
  }
}
