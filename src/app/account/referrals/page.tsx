import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import type { ReferralEarningStatus } from "@/generated/prisma/enums";
import { economics } from "@/config/economics";
import { serverEnv } from "@/config/env";
import { DRAFT_BANNER } from "@/domains/compliance/provenance-template";
import { ensureReferralCode, payoutEligibility } from "@/domains/growth/referrals";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function ReferralsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Referrals</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <Referrals />
      </Suspense>
    </div>
  );
}

const STATUS_LABEL: Record<ReferralEarningStatus, string> = {
  PENDING: "Waiting out the chargeback window",
  FROZEN: "Under review",
  PAYABLE: "Ready to pay",
  PAID: "Paid",
  CLAWED_BACK: "Reversed",
};

const ELIGIBILITY_HINT = {
  ACCOUNT_RESTRICTED: "Your account is restricted, so payouts are paused.",
  ID_NOT_VERIFIED: "Verify your ID to receive referral payouts.",
  NO_PAYOUT_ACCOUNT: "Set up payouts (the same Stripe account sellers use) to receive referral payouts.",
} as const;

async function Referrals() {
  await connection();
  const user = await requireUser();
  const [code, recruits, earnings, eligibility] = await Promise.all([
    ensureReferralCode(db, user.id),
    db.referral.findMany({
      where: { referrerUserId: user.id },
      orderBy: { createdAt: "desc" },
      include: { referee: { select: { displayName: true } } },
    }),
    db.referralEarning.findMany({
      where: { referral: { referrerUserId: user.id } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { referral: { include: { referee: { select: { displayName: true } } } }, order: { select: { listing: { select: { title: true } } } } },
    }),
    payoutEligibility(db, user.id),
  ]);
  const link = `${serverEnv().APP_URL}/signup?ref=${code}`;
  const total = (statuses: ReferralEarningStatus[]) =>
    earnings.filter((e) => statuses.includes(e.status)).reduce((sum, e) => sum + e.amountCents, 0);
  const rate = `${economics.referralBps / 100}%`;

  return (
    <>
      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Your referral link</h2>
        <p className="mt-1 text-sm text-stone-600">
          When someone joins with your link and sells, you earn {rate} of each of their sales, paid by Used Artifacts out of
          its own fees. Their prices and payouts don&apos;t change. You earn on real sales only, never for sign-ups.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <code className="rounded-lg bg-stone-100 px-3 py-2 font-mono text-sm">{link}</code>
          <span className="text-sm text-stone-500">
            Code <span className="font-mono font-semibold">{code}</span>
          </span>
        </div>
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-semibold">{DRAFT_BANNER}</p>
          <p className="mt-1">
            If you share your link publicly, say that you earn a commission when people you refer make sales (for
            example: &quot;I earn a referral commission from Used Artifacts&quot;). Referral payouts may be reported for
            tax purposes.
          </p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-4">
        {[
          { label: "Waiting", value: total(["PENDING"]) },
          { label: "Ready to pay", value: total(["PAYABLE"]) },
          { label: "Paid", value: total(["PAID"]) },
          { label: "Under review", value: total(["FROZEN"]) },
        ].map((t) => (
          <div key={t.label} className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
            <p className="text-xs uppercase tracking-wide text-stone-500">{t.label}</p>
            <p className="mt-1 text-xl font-semibold">{formatUsd(t.value)}</p>
          </div>
        ))}
      </section>
      <p className="text-sm text-stone-600">
        Earnings wait {economics.referralHoldDays} days after each sale completes, in case of a chargeback, then pay out
        automatically once you have at least {formatUsd(economics.referralMinPayoutCents)} ready.{" "}
        {eligibility.ok ? (
          "Your payout account is set up."
        ) : (
          <>
            {ELIGIBILITY_HINT[eligibility.reason]}{" "}
            {eligibility.reason === "ID_NOT_VERIFIED" && (
              <Link href="/account/verify" className="underline">
                Verify now
              </Link>
            )}
            {eligibility.reason === "NO_PAYOUT_ACCOUNT" && (
              <Link href="/sell" className="underline">
                Set up payouts
              </Link>
            )}
          </>
        )}
      </p>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">People you referred</h2>
        {recruits.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">No one yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100 text-sm">
            {recruits.map((r) => (
              <li key={r.id} className="flex justify-between py-2">
                <span>{r.referee.displayName}</span>
                <span className="text-stone-500">
                  joined {r.createdAt.toISOString().slice(0, 10)} · {r.firstSaleOrderId ? "selling" : "no sales yet"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Earnings</h2>
        {earnings.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">None yet.</p>
        ) : (
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="py-2 pr-4">Sale</th>
                <th className="py-2 pr-4">Seller</th>
                <th className="py-2 pr-4">Earned</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {earnings.map((e) => (
                <tr key={e.id}>
                  <td className="py-2 pr-4">{e.order.listing.title}</td>
                  <td className="py-2 pr-4">{e.referral.referee.displayName}</td>
                  <td className="py-2 pr-4">
                    {formatUsd(e.amountCents)}
                    <span className="block text-xs text-stone-500">
                      {e.rateBps / 100}% of {formatUsd(e.basisCents)}
                      {e.cappedAtFee ? " (capped at our fee)" : ""}
                    </span>
                  </td>
                  <td className="py-2">
                    {STATUS_LABEL[e.status]}
                    {e.status === "PENDING" && <span className="block text-xs text-stone-500">from {e.payableAt.toISOString().slice(0, 10)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
