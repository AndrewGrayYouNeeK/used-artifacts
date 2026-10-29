"use client";

import { useState } from "react";
import { enforceAction } from "@/app/actions/admin";
import { ActionForm, inputClass } from "@/components/action-form";
import type { ManualEnforcementType } from "@/domains/admin/enforcement";

const LABELS: Record<ManualEnforcementType, string> = {
  WARNING: "Issue warning",
  LISTING_REMOVED: "Remove a listing",
  BADGE_REVOKED: "Revoke a badge",
  SUSPENSION: "Suspend account",
  BAN: "Ban account",
};

type Option = { id: string; label: string };

export function EnforcementForm({
  userId,
  isOwner,
  listings,
  badges,
  signals,
  defaultSignalId,
}: {
  userId: string;
  isOwner: boolean;
  listings: Option[];
  badges: Option[];
  signals: Option[];
  defaultSignalId?: string;
}) {
  const [type, setType] = useState<ManualEnforcementType>("WARNING");
  const types = (Object.keys(LABELS) as ManualEnforcementType[]).filter((t) => isOwner || (t !== "SUSPENSION" && t !== "BAN"));
  const accountAction = type === "SUSPENSION" || type === "BAN";

  return (
    <ActionForm
      action={enforceAction}
      submitLabel={LABELS[type]}
      variant={accountAction ? "danger" : "primary"}
      confirm={type === "BAN" ? "Ban this account? Their live listings are removed and they're signed out." : undefined}
    >
      <input type="hidden" name="userId" value={userId} />
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Action</span>
        <select name="type" value={type} onChange={(e) => setType(e.target.value as ManualEnforcementType)} className={inputClass}>
          {types.map((t) => (
            <option key={t} value={t}>
              {LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {type === "LISTING_REMOVED" && (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Listing</span>
          <select name="listingId" required className={inputClass}>
            {listings.length === 0 && <option value="">No live or pending listings</option>}
            {listings.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {type === "BADGE_REVOKED" && (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Badge</span>
          <select name="userBadgeId" required className={inputClass}>
            {badges.length === 0 && <option value="">No active badges</option>}
            {badges.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {type === "SUSPENSION" && (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Days</span>
          <input name="days" type="number" min={1} max={365} defaultValue={7} required className={inputClass} />
        </label>
      )}
      {signals.length > 0 && (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Fraud signal (confirmed by this action)</span>
          <select name="fraudSignalId" defaultValue={defaultSignalId ?? ""} className={inputClass}>
            <option value="">None</option>
            {signals.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Reason (emailed to the user)</span>
        <textarea name="reason" required minLength={5} rows={3} className={inputClass} />
      </label>
      {accountAction && (
        <>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Your password, to confirm</span>
            <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Authenticator code</span>
            <input name="code" autoComplete="one-time-code" inputMode="numeric" className={inputClass} />
          </label>
        </>
      )}
    </ActionForm>
  );
}
