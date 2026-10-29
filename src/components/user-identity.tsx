import type { PublicBadge, PublicIdentity } from "@/domains/identity/public-identity";

/**
 * Renders a user's name and badges. Use this everywhere a user appears
 * (profiles, storefronts, listings, bids, comments) so the Proprietor badge is
 * always shown first and consistently.
 */
export function UserIdentity({
  identity,
  size = "md",
}: {
  identity: PublicIdentity;
  size?: "sm" | "md" | "lg";
}) {
  const nameClass = {
    sm: "text-sm font-medium",
    md: "text-base font-semibold",
    lg: "font-serif text-2xl font-semibold",
  }[size];

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className={nameClass}>{identity.displayName}</span>
      {identity.isProprietor && <ProprietorBadge size={size} />}
      {identity.badges.map((badge) => (
        <BadgePill key={badge.code} badge={badge} />
      ))}
    </span>
  );
}

export function ProprietorBadge({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizing = {
    sm: "px-2 py-0.5 text-[10px]",
    md: "px-2.5 py-0.5 text-xs",
    lg: "px-3 py-1 text-sm",
  }[size];

  return (
    <span
      title="Proprietor: founder and owner of Used Artifacts"
      className={`proprietor-sheen inline-flex items-center gap-1 rounded-full font-semibold uppercase tracking-[0.14em] text-stone-950 shadow-[0_0_0_1px_rgba(124,90,20,0.6),0_2px_8px_rgba(201,162,39,0.45)] ${sizing}`}
    >
      <svg aria-hidden viewBox="0 0 24 24" className="h-[1.1em] w-[1.1em]" fill="currentColor">
        <path d="M3 18h18l-1.5-9-4.5 4-3-7-3 7-4.5-4L3 18zm0 2h18v1.5H3V20z" />
      </svg>
      Proprietor
    </span>
  );
}

function BadgePill({ badge }: { badge: PublicBadge }) {
  switch (badge.kind) {
    case "COSMETIC":
      return (
        <span className="inline-flex items-center rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
          {badge.name}
        </span>
      );
    case "VOLUME":
      return (
        <span className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
          {badge.name}
        </span>
      );
    default: {
      const exhaustive: never = badge.kind;
      throw new Error(`Unknown badge kind: ${String(exhaustive)}`);
    }
  }
}
