import { Suspense } from "react";
import Link from "next/link";
import { decideAppealAction, decideFrozenEarningAction, reviewFraudSignalAction } from "@/app/actions/admin";
import { decideRetractionAction, voidBidsAction } from "@/app/actions/auctions";
import { recordDailyReviewAction } from "@/app/actions/beta";
import { openAppeals } from "@/domains/admin/appeals";
import { ACCOUNT_ACTIONS } from "@/domains/admin/enforcement";
import { recentDailyReviews, staffQueueCounts, utcDay } from "@/domains/admin/daily-review";
import { platform } from "@/config/platform";
import { ActionForm, inputClass } from "@/components/action-form";
import { signalAccounts } from "@/domains/admin/signals";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireStaff } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function AdminTrustPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Trust and safety</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <Trust />
      </Suspense>
    </div>
  );
}

const label = (v: string) => v.toLowerCase().replaceAll("_", " ");
const time = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16);

/** SHILL signals carry the auction they were raised on. */
const auctionIdOf = (evidence: unknown) =>
  typeof evidence === "object" && evidence !== null && "auctionId" in evidence && typeof evidence.auctionId === "string"
    ? evidence.auctionId
    : null;

async function Trust() {
  const staff = await requireStaff();
  const [signals, active, reviewed, frozen, retractions, appeals] = await Promise.all([
    db.fraudSignal.findMany({ where: { status: "OPEN" }, orderBy: [{ score: "desc" }, { createdAt: "asc" }], take: 100 }),
    db.enforcementAction.findMany({
      where: { liftedAt: null, type: { in: ["SUSPENSION", "BAN"] } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { id: true, displayName: true, email: true } }, actor: { select: { displayName: true } } },
    }),
    db.fraudSignal.findMany({
      where: { status: { not: "OPEN" } },
      orderBy: { reviewedAt: "desc" },
      take: 20,
      include: { reviewedBy: { select: { displayName: true } } },
    }),
    db.referralEarning.findMany({
      where: { status: "FROZEN" },
      orderBy: { createdAt: "asc" },
      take: 100,
      include: {
        referral: { include: { referrer: { select: { id: true, displayName: true } }, referee: { select: { id: true, displayName: true } } } },
        order: { select: { id: true, buyerUserId: true, listing: { select: { title: true } } } },
      },
    }),
    db.bidRetraction.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 100,
      include: {
        bid: {
          include: {
            bidder: { select: { id: true, displayName: true } },
            auction: { select: { status: true, endsAt: true, listing: { select: { id: true, title: true, updatedAt: true } } } },
          },
        },
      },
    }),
    openAppeals(db),
  ]);
  const accounts = await signalAccounts(db, signals);
  const reviews = await recentDailyReviews(db);
  const counts = await staffQueueCounts(db);
  const today = utcDay(new Date()).getTime();
  const doneToday = reviews.some((r) => r.day.getTime() === today);

  return (
    <>
      <section className={`rounded-2xl border p-6 shadow-sm ${doneToday ? "border-stone-200 bg-white" : "border-amber-300 bg-amber-50"}`}>
        <h2 className="font-serif text-lg font-semibold">Daily review</h2>
        <p className="mt-1 text-sm text-stone-600">
          During the beta someone on staff looks at every open signal, the compliance queue, disputes, holds, and feedback once a
          day, then signs off here.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {[
            ["Open signals", counts.openSignals, "/admin/trust"],
            ["Compliance queue", counts.pendingCompliance, "/admin/compliance"],
            ["Open disputes", counts.openDisputes, "/admin/orders"],
            ["Fraud holds", counts.fraudHolds, "/admin/orders"],
            ["Transfers retrying", counts.stuckTransfers, "/admin/orders"],
            ["Retraction requests", counts.pendingRetractions, "/admin/trust"],
            ["Open appeals", counts.openAppeals, "/admin/trust"],
            ["Open feedback", counts.openFeedback, "/admin/feedback"],
            ["Paused switches", counts.pausedSwitches.length, "/admin/beta"],
          ].map(([name, value, href]) => (
            <Link key={String(name)} href={String(href)} className="rounded-lg border border-stone-200 bg-white px-3 py-2 hover:border-stone-400">
              <dt className="text-xs text-stone-500">{name}</dt>
              <dd className="text-lg font-semibold">{value}</dd>
            </Link>
          ))}
        </dl>
        {doneToday ? (
          <p className="mt-4 text-sm text-emerald-800">Today&apos;s review is signed off.</p>
        ) : (
          <ActionForm action={recordDailyReviewAction} submitLabel="Sign off today's review" className="mt-4 flex flex-wrap items-start gap-2">
            <input name="notes" placeholder="Notes (optional)" className={`${inputClass} flex-1`} />
          </ActionForm>
        )}
        {reviews.length > 0 && (
          <ul className="mt-4 space-y-1 text-xs text-stone-500">
            {reviews.map((r) => (
              <li key={r.id}>
                {r.day.toISOString().slice(0, 10)}: {r.reviewedBy.displayName} · {r.openSignals} signals, {r.pendingCompliance} in compliance,{" "}
                {r.openFeedback} feedback{r.notes ? ` · ${r.notes}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Open fraud signals</h2>
        <p className="mt-1 text-sm text-stone-500">
          Signals are leads, not verdicts. Dismiss with notes, confirm with notes, or open an account and take action
          (which confirms the signal).
        </p>
        {signals.length === 0 && <p className="mt-4 text-sm text-stone-500">Nothing open.</p>}
        <ul className="mt-4 space-y-4">
          {signals.map((s) => (
            <li key={s.id} className="rounded-xl border border-stone-100 p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-red-800">
                  {label(s.detector)} · score {s.score}
                </span>
                <span className="text-xs text-stone-500">
                  {s.subjectType}:{s.subjectId.slice(0, 10)} · {time(s.createdAt)}
                </span>
              </div>
              <p className="mt-2 text-stone-700">
                Accounts:{" "}
                {(accounts.get(s.id) ?? []).map((u, i) => (
                  <span key={u.id}>
                    {i > 0 && ", "}
                    <Link href={`/admin/users/${u.id}?signal=${s.id}`} className="underline">
                      {u.displayName}
                    </Link>{" "}
                    <span className="text-stone-500">({u.status === "ACTIVE" ? u.email : label(u.status)})</span>
                  </span>
                ))}
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-stone-500">Evidence</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-stone-50 p-3 text-xs">{JSON.stringify(s.evidence, null, 2)}</pre>
              </details>
              <ActionForm action={reviewFraudSignalAction} submitLabel="Record review" variant="secondary" className="mt-3 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
                <input type="hidden" name="signalId" value={s.id} />
                <select name="status" className={inputClass} defaultValue="DISMISSED">
                  <option value="DISMISSED">Dismiss</option>
                  <option value="CONFIRMED">Confirm</option>
                </select>
                <input name="notes" required minLength={5} placeholder="What you found" className={inputClass} />
              </ActionForm>
              {s.detector === "SHILL" && s.subjectType === "User" && auctionIdOf(s.evidence) && (
                <ActionForm action={voidBidsAction} submitLabel="Void their bids on this auction" variant="danger" className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                  <input type="hidden" name="auctionId" value={auctionIdOf(s.evidence)!} />
                  <input type="hidden" name="bidderUserId" value={s.subjectId} />
                  <input type="hidden" name="fraudSignalId" value={s.id} />
                  <input name="reason" required minLength={5} placeholder="Reason (emailed to the bidder)" className={inputClass} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Appeals</h2>
        <p className="mt-1 text-sm text-stone-500">
          Members appeal from their account standing page (suspended and banned members reply to the notice email instead;
          lift those from their account). Overturning lifts the action; your notes are emailed to the member.
        </p>
        {appeals.length === 0 && <p className="mt-4 text-sm text-stone-500">Nothing open.</p>}
        <ul className="mt-4 space-y-4">
          {appeals.map((a) => (
            <li key={a.id} className="rounded-xl border border-stone-100 p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  <Link href={`/admin/users/${a.user.id}`} className="underline">
                    {a.user.displayName}
                  </Link>{" "}
                  · {label(a.enforcementAction.type)} on {time(a.enforcementAction.createdAt)}
                </span>
                <span className="text-xs text-stone-500">appealed {time(a.createdAt)}</span>
              </div>
              <p className="mt-1 text-stone-500">Action reason: {a.enforcementAction.reason}</p>
              <p className="mt-2 whitespace-pre-wrap text-stone-800">{a.message}</p>
              {a.user.id === staff.id ? (
                <p className="mt-3 text-xs text-stone-500">Your own appeal; another staff member decides it.</p>
              ) : (
                <ActionForm action={decideAppealAction} submitLabel="Record decision" variant="secondary" className="mt-3 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
                  <input type="hidden" name="appealId" value={a.id} />
                  <select name="decision" className={inputClass} defaultValue="UPHOLD">
                    <option value="UPHOLD">Uphold</option>
                    <option value="OVERTURN">Overturn</option>
                  </select>
                  <input name="notes" required minLength={5} placeholder="Decision (emailed to the member)" className={inputClass} />
                  {ACCOUNT_ACTIONS.has(a.enforcementAction.type) && (
                    <>
                      <input name="password" type="password" placeholder="Your password (to overturn)" className={inputClass} />
                      <input name="code" inputMode="numeric" placeholder="Authenticator code" className={inputClass} />
                    </>
                  )}
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>

      {(platform.auctionsEnabled || retractions.length > 0) && (
        <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="font-serif text-lg font-semibold">Bid retraction requests</h2>
          <p className="mt-1 text-sm text-stone-500">
            Typos are approved automatically. These claim a materially changed description or an unreachable seller; the
            bid stands until you decide.
          </p>
          {retractions.length === 0 && <p className="mt-4 text-sm text-stone-500">Nothing pending.</p>}
          <ul className="mt-4 space-y-4">
            {retractions.map((r) => (
              <li key={r.id} className="rounded-xl border border-stone-100 p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    <Link href={`/admin/users/${r.bid.bidder.id}`} className="underline">
                      {r.bid.bidder.displayName}
                    </Link>{" "}
                    · {label(r.kind)} · max {formatUsd(r.bid.maxProxyCents)}
                  </span>
                  <span className="text-xs text-stone-500">
                    <Link href={`/listings/${r.bid.auction.listing.id}`} className="underline">
                      {r.bid.auction.listing.title}
                    </Link>{" "}
                    · auction {label(r.bid.auction.status)}
                    {r.bid.auction.endsAt && ` until ${time(r.bid.auction.endsAt)}`}
                  </span>
                </div>
                <p className="mt-1 text-stone-700">{r.reason}</p>
                <p className="mt-1 text-xs text-stone-500">
                  Bid placed {time(r.bid.placedAt)} · listing last changed {time(r.bid.auction.listing.updatedAt)}
                </p>
                <ActionForm action={decideRetractionAction} submitLabel="Record decision" variant="secondary" className="mt-3 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
                  <input type="hidden" name="retractionId" value={r.id} />
                  <select name="decision" className={inputClass} defaultValue="DENY">
                    <option value="DENY">Decline</option>
                    <option value="APPROVE">Approve</option>
                  </select>
                  <input name="notes" required minLength={5} placeholder="Decision (emailed to the bidder)" className={inputClass} />
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Frozen referral earnings</h2>
        <p className="mt-1 text-sm text-stone-500">
          Held because the buyer, referrer, or recruit look linked. Release puts the earning back on the normal schedule;
          forfeit reverses it and records a fee forfeit against the referrer.
        </p>
        {frozen.length === 0 && <p className="mt-4 text-sm text-stone-500">Nothing frozen.</p>}
        <ul className="mt-4 space-y-4">
          {frozen.map((e) => (
            <li key={e.id} className="rounded-xl border border-stone-100 p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {formatUsd(e.amountCents)} to{" "}
                  <Link href={`/admin/users/${e.referral.referrer.id}`} className="underline">
                    {e.referral.referrer.displayName}
                  </Link>{" "}
                  on a sale by{" "}
                  <Link href={`/admin/users/${e.referral.referee.id}`} className="underline">
                    {e.referral.referee.displayName}
                  </Link>
                </span>
                <span className="text-xs text-stone-500">
                  {e.order.listing.title} · {time(e.createdAt)} ·{" "}
                  <Link href={`/admin/users/${e.order.buyerUserId}`} className="underline">
                    buyer
                  </Link>
                </span>
              </div>
              <p className="mt-1 text-red-800">{e.frozenReason}</p>
              <ActionForm action={decideFrozenEarningAction} submitLabel="Record decision" variant="secondary" className="mt-3 grid gap-2 sm:grid-cols-[auto_1fr_auto]">
                <input type="hidden" name="earningId" value={e.id} />
                <select name="decision" className={inputClass} defaultValue="FORFEIT">
                  <option value="FORFEIT">Forfeit</option>
                  <option value="RELEASE">Release</option>
                </select>
                <input name="reason" required minLength={5} placeholder="What you found (a forfeit reason is emailed)" className={inputClass} />
              </ActionForm>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Restricted accounts</h2>
        {active.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">None.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100 text-sm">
            {active.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  <Link href={`/admin/users/${a.user.id}`} className="font-medium underline">
                    {a.user.displayName}
                  </Link>{" "}
                  · {label(a.type)}
                  {a.expiresAt && ` until ${a.expiresAt.toISOString().slice(0, 10)}`}
                </span>
                <span className="text-stone-500">
                  {time(a.createdAt)} by {a.actor.displayName}: {a.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Recently reviewed signals</h2>
        {reviewed.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">None.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100 text-sm">
            {reviewed.map((s) => (
              <li key={s.id} className="py-2">
                <span className="font-medium">{label(s.detector)}</span> · {label(s.status)}
                {s.reviewedBy && ` by ${s.reviewedBy.displayName}`}
                {s.reviewedAt && ` · ${time(s.reviewedAt)}`}
                {s.reviewNotes && <span className="text-stone-500"> · {s.reviewNotes}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
