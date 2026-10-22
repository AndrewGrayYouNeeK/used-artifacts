import type { OrderStatus } from "@/generated/prisma/enums";

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  CREATED: "Awaiting payment",
  PAID_HELD: "Paid, waiting to ship",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  RELEASED: "Complete",
  AUTO_RELEASED: "Complete",
  DISPUTED: "Problem reported",
  RESOLVED_RELEASE: "Resolved: seller paid",
  RESOLVED_REFUND: "Resolved: refunded",
  RESOLVED_PARTIAL: "Resolved: partial refund",
  CANCELLED_REFUNDED: "Cancelled and refunded",
  EXPIRED: "Checkout expired",
};

const TONE: Record<OrderStatus, string> = {
  CREATED: "bg-stone-100 text-stone-700",
  PAID_HELD: "bg-sky-50 text-sky-800",
  SHIPPED: "bg-sky-50 text-sky-800",
  DELIVERED: "bg-sky-50 text-sky-800",
  RELEASED: "bg-emerald-50 text-emerald-800",
  AUTO_RELEASED: "bg-emerald-50 text-emerald-800",
  DISPUTED: "bg-amber-50 text-amber-900",
  RESOLVED_RELEASE: "bg-emerald-50 text-emerald-800",
  RESOLVED_REFUND: "bg-stone-100 text-stone-700",
  RESOLVED_PARTIAL: "bg-stone-100 text-stone-700",
  CANCELLED_REFUNDED: "bg-stone-100 text-stone-700",
  EXPIRED: "bg-stone-100 text-stone-500",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[status]}`}>{ORDER_STATUS_LABEL[status]}</span>;
}
