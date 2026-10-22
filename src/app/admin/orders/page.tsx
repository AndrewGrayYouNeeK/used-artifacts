import { Suspense } from "react";
import Link from "next/link";
import {
  confirmDeliveryAction,
  resolveDisputeAction,
  runEscrowJobsAction,
  setHoldAction,
} from "@/app/actions/orders";
import { ActionForm, inputClass } from "@/components/action-form";
import { OrderStatusBadge } from "@/components/order-status";
import { kindCreditBalance } from "@/domains/payments/ledger";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireStaff } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function AdminOrdersPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Orders and escrow</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <OrdersAdmin />
      </Suspense>
    </div>
  );
}

async function OrdersAdmin() {
  await requireStaff();
  const [disputes, held, inTransit, recent, balances] = await Promise.all([
    db.dispute.findMany({
      where: { status: { not: "RESOLVED" } },
      orderBy: { createdAt: "asc" },
      include: { order: { include: { listing: { select: { title: true } } } } },
    }),
    db.order.findMany({
      where: { releaseHold: true, status: { in: ["PAID_HELD", "SHIPPED", "DELIVERED", "DISPUTED"] } },
      include: { listing: { select: { title: true } } },
    }),
    db.order.findMany({
      where: { status: "SHIPPED" },
      orderBy: { shippedAt: "asc" },
      include: { listing: { select: { title: true } }, shipment: true },
    }),
    db.order.findMany({
      where: { status: { not: "EXPIRED" } },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { listing: { select: { title: true } } },
    }),
    Promise.all([
      kindCreditBalance(db, "BUYER_HELD"),
      kindCreditBalance(db, "SELLER_PAYABLE"),
      kindCreditBalance(db, "PLATFORM_REVENUE"),
      kindCreditBalance(db, "REFERRAL_PAYABLE"),
      kindCreditBalance(db, "TAX_PAYABLE"),
    ]),
  ]);
  const [buyerHeld, sellerPayable, platformRevenue, referralPayable, taxPayable] = balances;

  return (
    <>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["Held for buyers", buyerHeld],
          ["Owed to sellers", sellerPayable],
          ["Platform revenue", platformRevenue],
          ["Owed to referrers", referralPayable],
          ["Sales tax owed", taxPayable],
        ].map(([label, cents]) => (
          <div key={label} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
            <p className="text-xs text-stone-500">{label}</p>
            <p className="mt-1 text-lg font-semibold">{formatUsd(cents as number)}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-serif text-lg font-semibold">Escrow timers</h2>
            <p className="text-sm text-stone-600">
              Runs automatically via /api/cron/escrow. Expires unpaid checkouts, refunds unshipped orders,
              auto-releases delivered orders, retries transfers and refunds.
            </p>
          </div>
          <ActionForm action={runEscrowJobsAction} submitLabel="Run now" variant="secondary" />
        </div>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Open disputes ({disputes.length})</h2>
        {disputes.length === 0 && <p className="mt-2 text-sm text-stone-500">None.</p>}
        <ul className="mt-4 space-y-6">
          {disputes.map((d) => (
            <li key={d.id} className="rounded-xl border border-amber-200 p-4">
              <p className="font-medium">
                {d.order.listing.title} · {formatUsd(d.order.buyerPriceCents + d.order.shippingCents)}{" "}
                {d.isChargeback && <span className="text-red-700">(card chargeback)</span>}
              </p>
              <p className="mt-1 whitespace-pre-line text-sm text-stone-700">{d.reason}</p>
              <p className="mt-1 text-xs text-stone-500">
                Seller share {formatUsd(d.order.sellerPayoutCents + d.order.shippingCents)} · order {d.orderId}
              </p>
              {d.order.status === "DISPUTED" ? (
                <div className="mt-3">
                  <ActionForm action={resolveDisputeAction} submitLabel="Resolve" confirm="Move money as selected?">
                    <input type="hidden" name="disputeId" value={d.id} />
                    <div className="grid gap-2 sm:grid-cols-[12rem_8rem_1fr]">
                      <select name="resolution" className={inputClass} defaultValue="REFUND">
                        <option value="REFUND">Refund buyer in full</option>
                        <option value="RELEASE">Release to seller</option>
                        <option value="PARTIAL">Partial refund</option>
                      </select>
                      <input name="refund" placeholder="Partial $" inputMode="decimal" className={inputClass} />
                      <input name="notes" required placeholder="Decision notes (shown to both sides)" className={inputClass} />
                    </div>
                  </ActionForm>
                </div>
              ) : (
                <p className="mt-2 text-xs text-stone-500">
                  Order already {d.order.status.toLowerCase()}: handle the chargeback in the Stripe dashboard.
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Fraud holds ({held.length})</h2>
        {held.length === 0 && <p className="mt-2 text-sm text-stone-500">None.</p>}
        <ul className="mt-4 space-y-4">
          {held.map((o) => (
            <li key={o.id} className="text-sm">
              <p className="font-medium">
                {o.listing.title} <OrderStatusBadge status={o.status} />
              </p>
              <p className="text-stone-600">{o.releaseHoldReason}</p>
              <ActionForm action={setHoldAction} submitLabel="Clear hold" variant="secondary" className="mt-2 flex gap-2">
                <input type="hidden" name="orderId" value={o.id} />
                <input type="hidden" name="hold" value="false" />
                <input name="reason" required placeholder="Why it's safe to release" className={inputClass} />
              </ActionForm>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">In transit ({inTransit.length})</h2>
        <p className="text-sm text-stone-600">
          Without carrier tracking, staff confirm delivery from the carrier&apos;s site; that starts the hold period.
        </p>
        <ul className="mt-4 space-y-3">
          {inTransit.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>
                {o.listing.title} · {o.shipment?.carrier} <span className="font-mono">{o.shipment?.trackingNumber}</span>
              </span>
              <ActionForm action={confirmDeliveryAction} submitLabel="Carrier shows delivered" variant="secondary">
                <input type="hidden" name="orderId" value={o.id} />
              </ActionForm>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Recent orders</h2>
        <table className="mt-4 w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="py-2 pr-3">Item</th>
              <th className="py-2 pr-3">Buyer paid</th>
              <th className="py-2 pr-3">Seller gets</th>
              <th className="py-2 pr-3">Platform</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {recent.map((o) => (
              <tr key={o.id}>
                <td className="py-2 pr-3">
                  <Link href={`/listings/${o.listingId}`} className="underline">
                    {o.listing.title}
                  </Link>
                </td>
                <td className="py-2 pr-3">{formatUsd(o.buyerPriceCents + o.shippingCents + o.taxCents)}</td>
                <td className="py-2 pr-3">{formatUsd(o.sellerPayoutCents + o.shippingCents)}</td>
                <td className="py-2 pr-3">{formatUsd(o.platformFeeCents)}</td>
                <td className="py-2">
                  <OrderStatusBadge status={o.status} />
                  {o.releaseHold && <span className="ml-2 text-xs text-red-700">hold</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
