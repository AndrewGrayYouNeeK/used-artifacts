import { Suspense } from "react";
import { UserIdentity } from "@/components/user-identity";
import { economics, splitSale, type ReferralKind, type SellerTier } from "@/config/economics";
import { platform } from "@/config/platform";
import { verifyAuditChain } from "@/domains/audit/audit";
import { getPublicIdentity } from "@/domains/identity/public-identity";
import { requireOwner } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { SendResetButton } from "./send-reset-button";

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
  const [identity, users, events, chain] = await Promise.all([
    getPublicIdentity(db, owner.id),
    db.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    }),
    db.auditEvent.findMany({ orderBy: { seq: "desc" }, take: 25 }),
    verifyAuditChain(db),
  ]);

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
      </section>

      <EconomicsPanel />

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Users</h2>
        <p className="mt-1 text-sm text-stone-500">
          Staff can only send the standard reset email. Passwords are never set or shown here.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Email</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Verified</th>
                <th className="py-2 pr-4">Joined</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="py-2 pr-4">{u.displayName}</td>
                  <td className="py-2 pr-4">{u.email}</td>
                  <td className="py-2 pr-4">{u.role.toLowerCase()}</td>
                  <td className="py-2 pr-4">{u.emailVerifiedAt ? "yes" : "no"}</td>
                  <td className="py-2 pr-4">{u.createdAt.toISOString().slice(0, 10)}</td>
                  <td className="py-2 text-right">
                    {u.emailVerifiedAt && <SendResetButton userId={u.id} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-lg font-semibold">Audit log</h2>
          <span
            className={`text-xs font-medium ${chain.ok ? "text-emerald-700" : "text-red-700"}`}
          >
            {chain.ok
              ? `Hash chain intact (${chain.checked} events)`
              : `Hash chain BROKEN at event #${chain.firstBrokenSeq}`}
          </span>
        </div>
        <ul className="mt-4 divide-y divide-stone-100 font-mono text-xs">
          {events.map((e) => (
            <li key={e.id} className="flex gap-4 py-1.5">
              <span className="text-stone-400">#{e.seq.toString()}</span>
              <span className="text-stone-500">{e.at.toISOString().replace("T", " ").slice(0, 19)}</span>
              <span className="font-semibold">{e.action}</span>
              <span className="text-stone-500">
                {e.actorType.toLowerCase()} → {e.subjectType}:{e.subjectId?.slice(0, 8)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

function EconomicsPanel() {
  const sample = 10_000;
  const rows: { label: string; tier: SellerTier; kind: ReferralKind | null }[] = [
    { label: "Free seller, not referred", tier: "FREE", kind: null },
    { label: "Free seller, referred: first sale", tier: "FREE", kind: "FIRST_SALE" },
    { label: "Free seller, referred: later sales", tier: "FREE", kind: "ONGOING" },
    { label: "Paid seller, referred: first sale", tier: "PAID", kind: "FIRST_SALE" },
    { label: "Paid seller, referred: later sales", tier: "PAID", kind: "ONGOING" },
  ];

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <h2 className="font-serif text-lg font-semibold">Economics (config values)</h2>
      <p className="mt-1 text-sm text-stone-500">
        Free fee {pct(economics.platformFeeBps.FREE)} · Paid fee {pct(economics.platformFeeBps.PAID)} at $
        {(economics.paidTierPriceCents / 100).toFixed(2)}/mo · Referral {pct(economics.referralFirstSaleBps)} first
        sale, {pct(economics.referralOngoingBps)} ongoing (of sale price) · Cap at fee:{" "}
        {economics.referralCapAtPlatformFee ? "on" : "off"} · Verticals: {platform.enabledVerticals.join(", ")}
      </p>
      <table className="mt-4 w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wide text-stone-500">
          <tr>
            <th className="py-2 pr-4">On a $100 sale</th>
            <th className="py-2 pr-4">Platform fee</th>
            <th className="py-2 pr-4">Referral</th>
            <th className="py-2">Platform nets (before Stripe fees)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map((r) => {
            const s = splitSale({ saleCents: sample, sellerTier: r.tier, referralKind: r.kind });
            return (
              <tr key={r.label}>
                <td className="py-2 pr-4">{r.label}</td>
                <td className="py-2 pr-4">${(s.platformFeeCents / 100).toFixed(2)}</td>
                <td className="py-2 pr-4">
                  {s.referral ? `$${(s.referral.amountCents / 100).toFixed(2)}${s.referral.cappedAtFee ? " (capped)" : ""}` : "-"}
                </td>
                <td className={`py-2 font-medium ${s.platformNetCents === 0 ? "text-red-700" : ""}`}>
                  ${(s.platformNetCents / 100).toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
