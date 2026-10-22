import { Suspense } from "react";
import Link from "next/link";
import { revokeInviteAction, setKillSwitchAction } from "@/app/actions/beta";
import { ActionForm, inputClass } from "@/components/action-form";
import { platform } from "@/config/platform";
import { killSwitchStates } from "@/domains/admin/kill-switches";
import { formatInviteCode, inviteState, listBetaInvites, type InviteState } from "@/domains/growth/beta-invites";
import { requireStaff } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { CreateInviteForm } from "./invite-form";

export default function AdminBetaPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-12">
      <h1 className="font-serif text-2xl font-semibold">Beta controls</h1>
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <BetaControls />
      </Suspense>
    </div>
  );
}

const day = (d: Date) => d.toISOString().slice(0, 10);

const STATE_STYLE: Record<InviteState, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-800",
  USED_UP: "bg-stone-100 text-stone-600",
  EXPIRED: "bg-stone-100 text-stone-600",
  REVOKED: "bg-red-50 text-red-700",
};

async function BetaControls() {
  const staff = await requireStaff();
  const isOwner = staff.role === "OWNER";
  const switches = await killSwitchStates(db);
  const invites = isOwner ? await listBetaInvites(db) : [];
  const now = new Date();

  return (
    <>
      <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="font-serif text-lg font-semibold">Kill switches</h2>
        <p className="mt-1 text-sm text-stone-500">
          Pause part of the marketplace instantly. Any staff member can pause; only the owner can resume. Every change is in the
          audit log.
        </p>
        <ul className="mt-4 divide-y divide-stone-100">
          {switches.map((s) => (
            <li key={s.key} className="grid gap-3 py-4 sm:grid-cols-[1fr_20rem]">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.label}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.paused ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}
                  >
                    {s.paused ? "Paused" : "Running"}
                  </span>
                </div>
                <p className="mt-1 text-sm text-stone-500">{s.effect}</p>
                {s.updatedAt && (
                  <p className="mt-1 text-xs text-stone-500">
                    {s.paused ? "Paused" : "Resumed"} by {s.updatedBy ?? "unknown"} on {day(s.updatedAt)}: {s.reason}
                  </p>
                )}
              </div>
              {(!s.paused || isOwner) && (
                <ActionForm
                  action={setKillSwitchAction}
                  submitLabel={s.paused ? "Resume" : "Pause"}
                  variant={s.paused ? "primary" : "danger"}
                  confirm={s.paused ? undefined : `Pause ${s.label.toLowerCase()} for everyone?`}
                  className="flex items-start gap-2"
                >
                  <input type="hidden" name="key" value={s.key} />
                  <input type="hidden" name="paused" value={s.paused ? "false" : "true"} />
                  <input name="reason" required minLength={5} placeholder="Reason" className={inputClass} />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>

      {isOwner && (
        <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
          <h2 className="font-serif text-lg font-semibold">Invites</h2>
          <p className="mt-1 text-sm text-stone-500">
            {platform.betaInviteRequired
              ? "Signup is invite-only. Each code is shown once when you create it; only a hash is stored."
              : "BETA_INVITE_REQUIRED is off, so anyone can sign up. Invites still work but aren't needed."}
          </p>
          <div className="mt-4">
            <CreateInviteForm />
          </div>
          <table className="mt-6 w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="py-2">Code</th>
                <th>For</th>
                <th>Uses</th>
                <th>Status</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {invites.map((invite) => {
                const state = inviteState(invite, now);
                return (
                  <tr key={invite.id} className="align-top">
                    <td className="py-3 font-mono text-xs">…{formatInviteCode(invite.codeHint)}</td>
                    <td className="py-3">
                      {invite.note}
                      {invite.email && <div className="text-xs text-stone-500">{invite.email} only</div>}
                      <div className="text-xs text-stone-500">
                        {day(invite.createdAt)}
                        {invite.expiresAt ? ` · expires ${day(invite.expiresAt)}` : ""}
                      </div>
                    </td>
                    <td className="py-3">
                      {invite.useCount} / {invite.maxUses}
                    </td>
                    <td className="py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[state]}`}>{state.toLowerCase().replace("_", " ")}</span>
                    </td>
                    <td className="py-3">
                      {invite.redemptions.map((r) => (
                        <div key={r.id}>
                          <Link href={`/admin/users/${r.user.id}`} className="underline">
                            {r.user.displayName}
                          </Link>
                        </div>
                      ))}
                    </td>
                    <td className="py-3">
                      {state === "ACTIVE" && (
                        <ActionForm action={revokeInviteAction} submitLabel="Revoke" variant="secondary" confirm="Revoke this invite?">
                          <input type="hidden" name="inviteId" value={invite.id} />
                        </ActionForm>
                      )}
                    </td>
                  </tr>
                );
              })}
              {invites.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-stone-500">
                    No invites yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
