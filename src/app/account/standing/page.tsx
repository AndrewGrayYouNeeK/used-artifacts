import { Suspense } from "react";
import type { AppealStatus, EnforcementType } from "@/generated/prisma/enums";
import { submitAppealAction } from "@/app/actions/admin";
import { ActionForm, inputClass } from "@/components/action-form";
import { APPEAL_MAX_CHARS, APPEAL_MIN_CHARS } from "@/domains/admin/appeals";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";

export default function StandingPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Account standing</h1>
      <Suspense fallback={<div className="h-48 animate-pulse rounded-2xl bg-stone-100" />}>
        <Standing />
      </Suspense>
    </div>
  );
}

const TYPE_LABEL: Record<EnforcementType, string> = {
  WARNING: "Warning",
  BID_VOID: "Bids voided",
  LISTING_REMOVED: "Listing removed",
  FEE_FORFEIT: "Referral earnings forfeited",
  BADGE_REVOKED: "Badge removed",
  SUSPENSION: "Suspension",
  BAN: "Account closed",
};

const APPEAL_LABEL: Record<AppealStatus, string> = {
  OPEN: "Appeal under review",
  UPHELD: "Appeal reviewed: the action stands",
  OVERTURNED: "Appeal reviewed: overturned",
};

async function Standing() {
  const user = await requireUser();
  const actions = await db.enforcementAction.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { appeal: { select: { status: true, decisionNotes: true, createdAt: true } } },
  });

  if (actions.length === 0) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-900">
        Your account is in good standing. No actions have been taken against it.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-600">
        Every action our trust and safety team took on your account. If you think one is wrong, appeal it once here; staff
        review it and we email you the outcome.
      </p>
      {actions.map((a) => (
        <section key={a.id} className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-medium">{TYPE_LABEL[a.type]}</h2>
            <span className="text-xs text-stone-500">
              {a.createdAt.toISOString().slice(0, 10)}
              {a.liftedAt ? ` · lifted ${a.liftedAt.toISOString().slice(0, 10)}` : ""}
            </span>
          </div>
          <p className="mt-2 text-sm text-stone-700">{a.reason}</p>
          {a.appeal ? (
            <p className="mt-3 text-sm text-stone-600">
              {APPEAL_LABEL[a.appeal.status]}
              {a.appeal.decisionNotes ? `: ${a.appeal.decisionNotes}` : ""}
            </p>
          ) : a.liftedAt ? null : (
            <ActionForm action={submitAppealAction} submitLabel="Send appeal" variant="secondary" className="mt-3 space-y-2">
              <input type="hidden" name="enforcementActionId" value={a.id} />
              <textarea
                name="message"
                required
                minLength={APPEAL_MIN_CHARS}
                maxLength={APPEAL_MAX_CHARS}
                rows={3}
                placeholder="What should we know? Include order numbers or anything that shows what happened."
                className={inputClass}
              />
            </ActionForm>
          )}
        </section>
      ))}
    </div>
  );
}
