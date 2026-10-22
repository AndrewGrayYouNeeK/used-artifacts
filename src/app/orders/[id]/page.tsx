import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { confirmReceiptAction, openDisputeAction } from "@/app/actions/orders";
import { ActionForm, inputClass } from "@/components/action-form";
import { OrderStatusBadge } from "@/components/order-status";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function OrderPage({ params, searchParams }: PageProps<"/orders/[id]">) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <Order params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Order({
  params,
  searchParams,
}: {
  params: PageProps<"/orders/[id]">["params"];
  searchParams: PageProps<"/orders/[id]">["searchParams"];
}) {
  const [{ id }, { paid }] = await Promise.all([params, searchParams]);
  const user = await requireUser();
  const order = await db.order.findUnique({
    where: { id },
    include: {
      listing: { select: { id: true, title: true } },
      storefront: { select: { name: true, slug: true } },
      shipment: true,
      disputes: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!order || order.buyerUserId !== user.id) notFound();
  const total = order.buyerPriceCents + order.shippingCents + order.taxCents;
  const canConfirm = order.status === "SHIPPED" || order.status === "DELIVERED";
  const canDispute = order.status === "PAID_HELD" || canConfirm;

  return (
    <div className="space-y-6">
      {paid === "1" && order.status !== "CREATED" && (
        <p role="status" className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Payment received. Your money is held until you confirm the item arrived.
        </p>
      )}
      <section className="rounded-2xl border border-stone-200 bg-white p-8 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-stone-500">Order {order.id.slice(-8)}</p>
            <h1 className="mt-1 font-serif text-2xl font-semibold">
              <Link href={`/listings/${order.listing.id}`} className="hover:underline">
                {order.listing.title}
              </Link>
            </h1>
            <p className="text-sm text-stone-600">
              from <Link href={`/s/${order.storefront.slug}`} className="underline">{order.storefront.name}</Link>
            </p>
          </div>
          <OrderStatusBadge status={order.status} />
        </div>
        <dl className="mt-6 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
          <dt>Item</dt>
          <dd>{formatUsd(order.buyerPriceCents)}</dd>
          <dt>Shipping (US)</dt>
          <dd>{order.shippingCents > 0 ? formatUsd(order.shippingCents) : "Free"}</dd>
          {order.taxCents > 0 && (
            <>
              <dt>Sales tax</dt>
              <dd>{formatUsd(order.taxCents)}</dd>
            </>
          )}
          <dt className="font-semibold">Total paid</dt>
          <dd className="font-semibold">{formatUsd(total)}</dd>
        </dl>
        {order.shipment && (
          <p className="mt-4 text-sm text-stone-700">
            Shipped with {order.shipment.carrier}, tracking <span className="font-mono">{order.shipment.trackingNumber}</span>
            {order.shipment.deliveredAt && <> · delivered {order.shipment.deliveredAt.toISOString().slice(0, 10)}</>}
          </p>
        )}
        {order.status === "DELIVERED" && order.releaseEligibleAt && (
          <p className="mt-2 text-sm text-stone-600">
            Funds release to the seller on {order.releaseEligibleAt.toISOString().slice(0, 10)} unless you report a problem.
          </p>
        )}
      </section>

      {canConfirm && (
        <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="font-serif text-lg font-semibold">Did it arrive as described?</h2>
          <p className="mt-1 text-sm text-stone-600">Confirming pays the seller now. You can&apos;t undo this.</p>
          <div className="mt-4">
            <ActionForm action={confirmReceiptAction} submitLabel="Yes, it arrived as described" confirm="Pay the seller now?">
              <input type="hidden" name="orderId" value={order.id} />
            </ActionForm>
          </div>
        </section>
      )}

      {canDispute && (
        <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="font-serif text-lg font-semibold">Report a problem</h2>
          <p className="mt-1 text-sm text-stone-600">
            Not shipped, damaged, or not as described? Funds stay on hold while our team reviews it.
          </p>
          <div className="mt-4">
            <ActionForm action={openDisputeAction} submitLabel="Report a problem" variant="danger">
              <input type="hidden" name="orderId" value={order.id} />
              <textarea name="reason" required minLength={20} rows={3} placeholder="What went wrong?" className={inputClass} />
            </ActionForm>
          </div>
        </section>
      )}

      {order.disputes.map((d) => (
        <section key={d.id} className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-950">
          <p className="font-medium">
            {d.isChargeback ? "Card chargeback" : "Problem reported"} on {d.createdAt.toISOString().slice(0, 10)}:{" "}
            {d.status === "RESOLVED" ? `resolved (${d.resolution?.toLowerCase()})` : "under review"}
          </p>
          <p className="mt-1 whitespace-pre-line">{d.reason}</p>
          {d.resolutionNotes && <p className="mt-2">Decision: {d.resolutionNotes}</p>}
        </section>
      ))}
    </div>
  );
}
