import type { OrderStatus } from "@/generated/prisma/enums";

export type OrderEvent =
  | "PAYMENT_SUCCEEDED"
  | "PAYMENT_WINDOW_EXPIRED"
  | "SELLER_SHIPPED"
  | "SELLER_CANCELLED"
  | "SHIP_DEADLINE_MISSED"
  | "CARRIER_DELIVERED"
  | "BUYER_CONFIRMED"
  | "AUTO_RELEASE"
  | "DISPUTE_OPENED"
  | "DISPUTE_RELEASE"
  | "DISPUTE_REFUND"
  | "DISPUTE_PARTIAL";

/**
 * The escrow state machine (BUILD_PLAN 3.3). The migration's
 * order_status_guard trigger enforces the same edges in the database.
 */
const EDGES: Record<OrderEvent, Partial<Record<OrderStatus, OrderStatus>>> = {
  PAYMENT_SUCCEEDED: { CREATED: "PAID_HELD" },
  PAYMENT_WINDOW_EXPIRED: { CREATED: "EXPIRED" },
  SELLER_SHIPPED: { PAID_HELD: "SHIPPED" },
  SELLER_CANCELLED: { PAID_HELD: "CANCELLED_REFUNDED" },
  SHIP_DEADLINE_MISSED: { PAID_HELD: "CANCELLED_REFUNDED" },
  CARRIER_DELIVERED: { SHIPPED: "DELIVERED" },
  BUYER_CONFIRMED: { SHIPPED: "RELEASED", DELIVERED: "RELEASED" },
  AUTO_RELEASE: { DELIVERED: "AUTO_RELEASED" },
  DISPUTE_OPENED: { PAID_HELD: "DISPUTED", SHIPPED: "DISPUTED", DELIVERED: "DISPUTED" },
  DISPUTE_RELEASE: { DISPUTED: "RESOLVED_RELEASE" },
  DISPUTE_REFUND: { DISPUTED: "RESOLVED_REFUND" },
  DISPUTE_PARTIAL: { DISPUTED: "RESOLVED_PARTIAL" },
};

export function nextStatus(from: OrderStatus, event: OrderEvent): OrderStatus | null {
  return EDGES[event][from] ?? null;
}

/** Statuses in which the seller has been (or is being) paid. */
export const RELEASED_STATUSES = ["RELEASED", "AUTO_RELEASED", "RESOLVED_RELEASE", "RESOLVED_PARTIAL"] as const satisfies OrderStatus[];

/** Funds are held: the buyer has paid and the seller hasn't been paid yet. */
export const HELD_STATUSES = ["PAID_HELD", "SHIPPED", "DELIVERED", "DISPUTED"] as const satisfies OrderStatus[];

export function isReleased(status: OrderStatus): boolean {
  return (RELEASED_STATUSES as readonly OrderStatus[]).includes(status);
}

/** Every edge, for the trigger test that keeps code and database in sync. */
export function allEdges(): [OrderStatus, OrderStatus][] {
  return Object.values(EDGES).flatMap((m) =>
    Object.entries(m).map(([from, to]): [OrderStatus, OrderStatus] => [from as OrderStatus, to as OrderStatus]),
  );
}
