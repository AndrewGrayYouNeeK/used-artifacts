import { Suspense } from "react";
import Link from "next/link";
import { OrderStatusBadge } from "@/components/order-status";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function OrdersPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Your purchases</h1>
      <Suspense fallback={<div className="mt-6 h-40 animate-pulse rounded-2xl bg-stone-100" />}>
        <Purchases />
      </Suspense>
    </div>
  );
}

async function Purchases() {
  const user = await requireUser();
  const orders = await db.order.findMany({
    where: { buyerUserId: user.id, status: { not: "EXPIRED" } },
    orderBy: { createdAt: "desc" },
    include: { listing: { select: { title: true } }, storefront: { select: { name: true } } },
  });
  if (orders.length === 0) {
    return (
      <p className="mt-6 text-sm text-stone-600">
        No purchases yet. <Link href="/browse" className="underline">Browse the collection</Link>.
      </p>
    );
  }
  return (
    <ul className="mt-6 divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white shadow-sm">
      {orders.map((o) => (
        <li key={o.id}>
          <Link href={`/orders/${o.id}`} className="flex items-center justify-between gap-4 px-6 py-4 hover:bg-stone-50">
            <div>
              <p className="font-medium">{o.listing.title}</p>
              <p className="text-xs text-stone-500">
                {o.storefront.name} · {o.createdAt.toISOString().slice(0, 10)}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm">{formatUsd(o.buyerPriceCents + o.shippingCents + o.taxCents)}</span>
              <OrderStatusBadge status={o.status} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
