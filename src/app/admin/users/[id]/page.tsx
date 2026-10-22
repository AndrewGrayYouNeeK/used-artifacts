import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { liftEnforcementFormAction, setUserRoleAction } from "@/app/actions/admin";
import { ActionForm, inputClass } from "@/components/action-form";
import { OrderStatusBadge } from "@/components/order-status";
import { ACCOUNT_ACTIONS } from "@/domains/admin/enforcement";
import { openSignalsForUser } from "@/domains/admin/signals";
import { searchAuditEvents } from "@/domains/audit/audit";
import { formatUsd } from "@/domains/pricing/pricing";
import { requireStaff } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { SendResetButton } from "../../send-reset-button";
import { EnforcementForm } from "./enforcement-form";

export default function AdminUserPage({ params, searchParams }: PageProps<"/admin/users/[id]">) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-stone-100" />}>
        <UserDetail params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const time = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16);
const label = (v: string) => v.toLowerCase().replaceAll("_", " ");

async function UserDetail({
  params,
  searchParams,
}: {
  params: PageProps<"/admin/users/[id]">["params"];
  searchParams: PageProps<"/admin/users/[id]">["searchParams"];
}) {
  const staff = await requireStaff();
  const { id } = await params;
  const { signal } = await searchParams;
  const user = await db.user.findUnique({
    where: { id },
    include: {
      identityVerification: true,
      ownedStorefronts: true,
      badges: { include: { badge: true }, orderBy: { awardedAt: "asc" } },
      enforcementActions: {
        orderBy: { createdAt: "desc" },
        include: {
          actor: { select: { displayName: true } },
          liftedBy: { select: { displayName: true } },
          listing: { select: { title: true } },
          userBadge: { include: { badge: { select: { name: true } } } },
        },
      },
      referredBy: { include: { referrer: { select: { id: true, displayName: true } } } },
      linksA: { include: { userB: { select: { id: true, displayName: true, status: true } } } },
      linksB: { include: { userA: { select: { id: true, displayName: true, status: true } } } },
      loginEvents: { orderBy: { at: "desc" }, take: 15 },
    },
  });
  if (!user) notFound();

  const [listings, purchases, sales, signals, aboutEvents, byEvents, recruits, earnings] = await Promise.all([
    db.listing.findMany({ where: { sellerUserId: id }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, title: true, status: true, askingPriceCents: true, createdAt: true } }),
    db.order.findMany({ where: { buyerUserId: id }, orderBy: { createdAt: "desc" }, take: 15, include: { listing: { select: { title: true } } } }),
    db.order.findMany({ where: { sellerUserId: id }, orderBy: { createdAt: "desc" }, take: 15, include: { listing: { select: { title: true } } } }),
    openSignalsForUser(db, id),
    searchAuditEvents(db, { subjectType: "User", subjectId: id, limit: 25 }),
    searchAuditEvents(db, { actorUserId: id, limit: 25 }),
    db.referral.count({ where: { referrerUserId: id } }),
    db.referralEarning.groupBy({ by: ["status"], where: { referral: { referrerUserId: id } }, _sum: { amountCents: true } }),
  ]);
  const isOwner = staff.role === "OWNER";
  const isTargetOwner = user.role === "OWNER";
  const links = [
    ...user.linksA.map((l) => ({ id: l.id, signal: l.signal, strength: l.strength, other: l.userB })),
    ...user.linksB.map((l) => ({ id: l.id, signal: l.signal, strength: l.strength, other: l.userA })),
  ];
  const signalOptions = signals.map((s) => ({ id: s.id, label: `${label(s.detector)} · score ${s.score} · ${day(s.createdAt)}` }));

  return (
    <>
      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-serif text-2xl font-semibold">{user.displayName}</h1>
            <p className="text-sm text-stone-600">{user.email}</p>
            <p className="mt-2 text-sm">
              <span className="rounded bg-stone-100 px-2 py-0.5">{label(user.role)}</span>{" "}
              <span className={`rounded px-2 py-0.5 ${user.status === "ACTIVE" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
                {label(user.status)}
              </span>{" "}
              <span className="text-stone-500">
                joined {day(user.createdAt)} · email {user.emailVerifiedAt ? "verified" : "unverified"} · ID check{" "}
                {user.identityVerification ? label(user.identityVerification.status) : "not started"}
              </span>
            </p>
            {user.badges.length > 0 && (
              <p className="mt-2 text-xs text-stone-500">
                Badges:{" "}
                {user.badges.map((b) => `${b.badge.name}${b.revokedAt ? " (revoked)" : ""}`).join(", ")}
              </p>
            )}
          </div>
          <div className="text-right">
            {user.emailVerifiedAt && <SendResetButton userId={user.id} />}
            <p className="mt-1 text-xs text-stone-500">Passwords are never set or shown by staff.</p>
          </div>
        </div>
      </section>

      {!isTargetOwner && user.id !== staff.id && (
        <div className="grid gap-6 md:grid-cols-2">
          <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
            <h2 className="font-serif text-lg font-semibold">Take action</h2>
            <p className="mt-1 mb-4 text-sm text-stone-500">
              Every action is recorded permanently, audited and emailed to the user with your reason.
              {!isOwner && " Suspensions and bans are owner-only."}
            </p>
            <EnforcementForm
              userId={user.id}
              isOwner={isOwner}
              listings={listings.filter((l) => l.status === "LIVE" || l.status === "PENDING_REVIEW").map((l) => ({ id: l.id, label: `${l.title} (${label(l.status)})` }))}
              badges={user.badges.filter((b) => !b.revokedAt).map((b) => ({ id: b.id, label: b.badge.name }))}
              signals={signalOptions}
              defaultSignalId={typeof signal === "string" ? signal : undefined}
            />
          </section>
          {isOwner && (
            <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
              <h2 className="font-serif text-lg font-semibold">Staff role</h2>
              <p className="mt-1 mb-4 text-sm text-stone-500">
                Moderators can review listings, identity matches, disputes and fraud signals, and issue warnings, listing
                removals and badge revocations. Only you can suspend, ban or change roles.
              </p>
              <ActionForm action={setUserRoleAction} submitLabel={user.role === "MODERATOR" ? "Remove moderator" : "Make moderator"} variant="secondary">
                <input type="hidden" name="userId" value={user.id} />
                <input type="hidden" name="role" value={user.role === "MODERATOR" ? "USER" : "MODERATOR"} />
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">Your password, to confirm</span>
                  <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
                </label>
              </ActionForm>
            </section>
          )}
        </div>
      )}

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Enforcement history</h2>
        {user.enforcementActions.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">None.</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {user.enforcementActions.map((e) => (
              <li key={e.id} className="rounded-xl border border-stone-100 p-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {label(e.type)}
                    {e.listing && `: ${e.listing.title}`}
                    {e.userBadge && `: ${e.userBadge.badge.name}`}
                  </span>
                  <span className="text-xs text-stone-500">
                    {time(e.createdAt)} by {e.actor.displayName}
                    {e.expiresAt && ` · until ${day(e.expiresAt)}`}
                  </span>
                </div>
                <p className="mt-1 text-stone-700">{e.reason}</p>
                {e.liftedAt ? (
                  <p className="mt-2 text-xs text-emerald-800">
                    Lifted {time(e.liftedAt)}
                    {e.liftedBy ? ` by ${e.liftedBy.displayName}` : ""}: {e.liftReason}
                  </p>
                ) : (
                  ["LISTING_REMOVED", "BID_VOID", "FEE_FORFEIT"].includes(e.type) ||
                  (ACCOUNT_ACTIONS.has(e.type) && !isOwner) || (
                    <ActionForm action={liftEnforcementFormAction} submitLabel="Lift on appeal" variant="secondary" className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                      <input type="hidden" name="enforcementId" value={e.id} />
                      <input name="reason" required minLength={5} placeholder="Appeal outcome" className={inputClass} />
                      {ACCOUNT_ACTIONS.has(e.type) && (
                        <input name="password" type="password" autoComplete="current-password" required placeholder="Your password" className={inputClass} />
                      )}
                    </ActionForm>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Fraud signals and linked accounts</h2>
        {signals.length === 0 && links.length === 0 && <p className="mt-2 text-sm text-stone-500">None.</p>}
        {signals.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {signals.map((s) => (
              <li key={s.id}>
                <span className="font-medium text-red-800">{label(s.detector)}</span> · score {s.score} · {day(s.createdAt)} ·{" "}
                <Link href="/admin/trust" className="underline">
                  review
                </Link>
              </li>
            ))}
          </ul>
        )}
        {links.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {links.map((l) => (
              <li key={l.id}>
                Linked by {label(l.signal)} (strength {l.strength}) to{" "}
                <Link href={`/admin/users/${l.other.id}`} className="underline">
                  {l.other.displayName}
                </Link>{" "}
                <span className="text-stone-500">({label(l.other.status)})</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Referrals</h2>
        <p className="mt-2 text-sm">
          {user.referredBy ? (
            <>
              Referred by{" "}
              <Link href={`/admin/users/${user.referredBy.referrer.id}`} className="underline">
                {user.referredBy.referrer.displayName}
              </Link>{" "}
              on {day(user.referredBy.createdAt)}.
            </>
          ) : (
            "Not referred."
          )}{" "}
          Referred {recruits} account{recruits === 1 ? "" : "s"}.
        </p>
        {earnings.length > 0 && (
          <p className="mt-1 text-sm text-stone-600">
            Earnings: {earnings.map((g) => `${label(g.status)} ${formatUsd(g._sum.amountCents ?? 0)}`).join(" · ")}
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Storefront and listings</h2>
        {user.ownedStorefronts.map((s) => (
          <p key={s.id} className="mt-2 text-sm">
            <Link href={`/s/${s.slug}`} className="font-medium underline">
              {s.name}
            </Link>{" "}
            <span className="text-stone-500">
              · {label(s.status)} · payouts {s.payoutsEnabled ? "enabled" : "not enabled"}
            </span>
          </p>
        ))}
        {listings.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">No listings.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100 text-sm">
            {listings.map((l) => (
              <li key={l.id} className="flex justify-between gap-4 py-1.5">
                <Link href={`/listings/${l.id}`} className="underline-offset-2 hover:underline">
                  {l.title}
                </Link>
                <span className="text-stone-500">
                  {label(l.status)} · {l.askingPriceCents === null ? "-" : formatUsd(l.askingPriceCents)} · {day(l.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        {[
          { title: "Purchases", orders: purchases },
          { title: "Sales", orders: sales },
        ].map(({ title, orders }) => (
          <section key={title} className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
            <h2 className="font-serif text-lg font-semibold">{title}</h2>
            {orders.length === 0 ? (
              <p className="mt-2 text-sm text-stone-500">None.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {orders.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{o.listing.title}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {formatUsd(o.buyerPriceCents)} <OrderStatusBadge status={o.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Recent sign-in attempts</h2>
        <ul className="mt-3 space-y-1 font-mono text-xs">
          {user.loginEvents.map((e) => (
            <li key={e.id} className={e.succeeded ? "" : "text-red-700"}>
              {time(e.at)} · {e.succeeded ? "correct password" : "wrong password"} · ip {e.ipHash?.slice(0, 10) ?? "-"} · device {e.deviceIdHash?.slice(0, 10) ?? "-"}
            </li>
          ))}
        </ul>
        {user.loginEvents.length === 0 && <p className="mt-2 text-sm text-stone-500">None.</p>}
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-lg font-semibold">Audit trail</h2>
          <Link href={`/admin/audit?subjectId=${user.id}`} className="text-sm underline">
            Full log →
          </Link>
        </div>
        <div className="mt-3 grid gap-6 md:grid-cols-2">
          {[
            { title: "About this account", events: aboutEvents.events },
            { title: "Done by this account", events: byEvents.events },
          ].map(({ title, events }) => (
            <div key={title}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">{title}</h3>
              <ul className="mt-2 space-y-1 font-mono text-xs">
                {events.map((e) => (
                  <li key={e.id}>
                    <span className="text-stone-400">#{e.seq.toString()}</span> {time(e.at)} <span className="font-semibold">{e.action}</span>
                  </li>
                ))}
              </ul>
              {events.length === 0 && <p className="mt-2 text-sm text-stone-500">None.</p>}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
