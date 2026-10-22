import { Suspense } from "react";
import Link from "next/link";
import { UserIdentity } from "@/components/user-identity";
import { economics, splitSale } from "@/config/economics";
import { platform } from "@/config/platform";
import { gmMetrics, whatSells } from "@/domains/admin/metrics";
import { verifyAuditChain } from "@/domains/audit/audit";
import { getPublicIdentity } from "@/domains/identity/public-identity";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireOwner } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function AdminPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-12">
      <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-stone-100" />}>
        <Dashboard />
      </Suspense>
    </div>
  );
}

async function Dashboard() {
  const owner = await requireOwner();
  const [identity, metrics, sells, chain, openIdentityReviews] = await Promise.all([
    getPublicIdentity(db, owner.id),
    gmMetrics(db),
    whatSells(db),
    verifyAuditChain(db),
    db.identityVerification.count({ where: { status: "NEEDS_REVIEW" } }),
  ]);
  const openSignals = metrics.trust.openSignals.reduce((n, s) => n + s.count, 0);

  return (
    <>
      <section className="rounded-2xl border border-amber-200 bg-gradient-to-br from-white to-amber-50 p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-800">GM dashboard</p>
        <div className="mt-3">{identity && <UserIdentity identity={identity} size="lg" />}</div>
        <p className="mt-1 text-sm text-stone-600">{owner.email}</p>
        {identity && !identity.isProprietor && (
          <p className="mt-4 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
            The Proprietor badge hasn&apos;t been assigned yet. Run{" "}
            <code className="font-mono">PROPRIETOR_EMAIL=you@example.com npm run proprietor:assign</code>{" "}
            on the server. It can only be done once.
          </p>
        )}
        <p className={`mt-4 text-xs font-medium ${chain.ok ? "text-emerald-700" : "text-red-700"}`}>
          {chain.ok
            ? `Audit hash chain intact (${chain.checked} events)`
            : `Audit hash chain BROKEN at event #${chain.firstBrokenSeq}. Investigate before anything else.`}
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <QueueLink
          href="/admin/compliance"
          title="Compliance queue"
          detail={`${metrics.compliance.open} listing(s) · ${openIdentityReviews} identity match(es)`}
        />
        <QueueLink href="/admin/trust" title="Trust & safety" detail={`${openSignals} open signal(s) · ${metrics.trust.activeSuspensions} suspended`} />
        <QueueLink href="/admin/orders" title="Orders and escrow" detail={`${metrics.sales.openDisputes} open dispute(s) · ${formatUsd(metrics.sales.heldCents)} held`} />
      </div>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Marketplace health</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-4">
          <Metric label="GMV, last 30 days" value={formatUsd(metrics.sales.last30.gmvCents)} sub={`${metrics.sales.last30.orders} released order(s)`} />
          <Metric label="Platform fees, last 30 days" value={formatUsd(metrics.sales.last30.platformFeeCents)} sub={`${formatUsd(metrics.sales.allTime.platformFeeCents)} all time`} />
          <Metric label="Platform revenue (ledger)" value={formatUsd(metrics.sales.platformRevenueCents)} sub="after referral payouts" />
          <Metric label="Dispute rate, 90 days" value={percent(metrics.sales.disputeRate90)} sub={`${metrics.sales.openDisputes} open`} />
          <Metric label="Users" value={String(metrics.users.total)} sub={`${metrics.users.newLast30} new in 30 days`} />
          <Metric label="Verified sellers" value={String(metrics.users.verifiedSellers)} sub={`${metrics.storefronts.payoutsEnabled}/${metrics.storefronts.total} storefronts can take payouts`} />
          <Metric label="Live listings" value={String(metrics.listings.live)} sub={`${metrics.listings.sold} sold · ${metrics.listings.removed} removed`} />
          <Metric
            label="Compliance, last 30 days"
            value={percent(metrics.compliance.approvalRate30)}
            sub={`approved · median ${metrics.compliance.medianHoursToDecision === null ? "-" : `${metrics.compliance.medianHoursToDecision.toFixed(1)}h`} to decide`}
          />
          <Metric label="AI red-flag rate, 30 days" value={percent(metrics.compliance.aiRedFlagRate30)} sub="submissions held by the analyzer" />
          <Metric label="Moderators" value={String(metrics.users.moderators)} sub="the owner is separate" />
          <Metric label="Suspended / banned" value={`${metrics.users.suspended} / ${metrics.users.banned}`} sub={`${metrics.trust.bansAllTime} ban(s) all time`} />
          <Metric
            label="Open fraud signals"
            value={String(openSignals)}
            sub={metrics.trust.openSignals.map((s) => `${s.detector.toLowerCase().replaceAll("_", " ")} ${s.count}`).join(" · ") || "none"}
          />
        </dl>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">What sells</h2>
        <p className="mt-1 text-sm text-stone-500">
          Sell-through by category from every closed listing (sold, expired, withdrawn or removed). This feeds the grading
          plan: categories that sell well are where authentication partners matter first.
        </p>
        {sells.length === 0 ? (
          <p className="mt-4 text-sm text-stone-500">No closed listings yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="py-2 pr-4">Category</th>
                  <th className="py-2 pr-4">Sold / closed</th>
                  <th className="py-2 pr-4">Sell-through</th>
                  <th className="py-2 pr-4">Median days to sell</th>
                  <th className="py-2 pr-4">Avg sale</th>
                  <th className="py-2">Avg ask</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {sells.map((r) => (
                  <tr key={r.categoryId}>
                    <td className="py-2 pr-4">{r.categoryName}</td>
                    <td className="py-2 pr-4">
                      {r.sold} / {r.closed}
                    </td>
                    <td className="py-2 pr-4">{percent(r.sellThrough)}</td>
                    <td className="py-2 pr-4">{r.medianDaysToSell === null ? "-" : r.medianDaysToSell.toFixed(1)}</td>
                    <td className="py-2 pr-4">{r.avgSaleCents === null ? "-" : formatUsd(r.avgSaleCents)}</td>
                    <td className="py-2">{r.avgAskCents === null ? "-" : formatUsd(r.avgAskCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <EconomicsPanel />
    </>
  );
}

const percent = (r: number | null) => (r === null ? "-" : `${(r * 100).toFixed(r * 100 < 10 ? 1 : 0)}%`);

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl bg-stone-50 p-4">
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
      <dd className="mt-0.5 text-xs text-stone-500">{sub}</dd>
    </div>
  );
}

function QueueLink({ href, title, detail }: { href: string; title: string; detail: string }) {
  return (
    <Link href={href} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm hover:border-stone-400">
      <h2 className="font-serif font-semibold">{title} →</h2>
      <p className="mt-1 text-sm text-stone-500">{detail}</p>
    </Link>
  );
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

function EconomicsPanel() {
  const rows: { label: string; referred: boolean }[] = [
    { label: "Seller not referred", referred: false },
    { label: "Referred seller (every sale, incl. first)", referred: true },
  ];

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <h2 className="font-serif text-lg font-semibold">Economics (config values)</h2>
      <p className="mt-1 text-sm text-stone-500">
        Buyer fee {pct(economics.buyerFeeBps)} built into the shown price · Seller fee{" "}
        {pct(economics.sellerFeeBps)} deducted from payout · Free membership, no paid tier ·
        Referral {pct(economics.referralBps)} of the{" "}
        {economics.referralBasis === "BUYER_PRICE" ? "buyer price" : "asking price"} on every recruit
        sale, paid from the platform take · Cap at take:{" "}
        {economics.referralCapAtPlatformFee ? "on" : "off"} · Verticals:{" "}
        {platform.enabledVerticals.join(", ")}
      </p>
      <table className="mt-4 w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-stone-500">
          <tr>
            <th className="py-2 pr-4">$100 asking price</th>
            <th className="py-2 pr-4">Buyer pays</th>
            <th className="py-2 pr-4">Seller payout</th>
            <th className="py-2 pr-4">Platform take</th>
            <th className="py-2 pr-4">Referral</th>
            <th className="py-2">Platform nets (before Stripe fees)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map((r) => {
            const s = splitSale({ askingCents: 10_000, referred: r.referred });
            return (
              <tr key={r.label}>
                <td className="py-2 pr-4">{r.label}</td>
                <td className="py-2 pr-4">{formatUsd(s.buyerPriceCents)}</td>
                <td className="py-2 pr-4">{formatUsd(s.sellerPayoutCents)}</td>
                <td className="py-2 pr-4">{formatUsd(s.platformFeeCents)}</td>
                <td className="py-2 pr-4">
                  {s.referral
                    ? `${formatUsd(s.referral.amountCents)}${s.referral.cappedAtFee ? " (capped)" : ""}`
                    : "-"}
                </td>
                <td className={`py-2 font-medium ${s.platformNetCents <= 0 ? "text-red-700" : ""}`}>
                  {formatUsd(s.platformNetCents)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
