import Link from "next/link";
import type { IdentityVerificationStatus } from "@/generated/prisma/enums";

export function identityStatusCopy(status: IdentityVerificationStatus | null): {
  label: string;
  detail: string;
  tone: "ok" | "warn" | "bad" | "neutral";
  canStart: boolean;
} {
  switch (status) {
    case null:
      return { label: "Not verified", detail: "Verify your ID to sell. Browsing and buying don't need it.", tone: "neutral", canStart: true };
    case "PENDING":
      return { label: "Not finished", detail: "You started verification but didn't finish. You can try again.", tone: "warn", canStart: true };
    case "PROCESSING":
      return { label: "Processing", detail: "Your ID is being checked. This usually takes a minute or two.", tone: "neutral", canStart: false };
    case "REQUIRES_INPUT":
      return { label: "Needs another try", detail: "The check couldn't be completed. Make sure the photos are clear and try again.", tone: "warn", canStart: true };
    case "CANCELED":
      return { label: "Canceled", detail: "Verification was canceled. You can start again.", tone: "warn", canStart: true };
    case "VERIFIED":
      return { label: "Verified", detail: "Your identity is verified. You can open a storefront and sell.", tone: "ok", canStart: false };
    case "NEEDS_REVIEW":
      return { label: "Under review", detail: "Our team is reviewing your verification. We'll email you when it's done.", tone: "warn", canStart: false };
    case "DUPLICATE_REJECTED":
      return { label: "Not accepted", detail: "This ID is already linked to another account. Each person may have only one account. Contact support if this is a mistake.", tone: "bad", canStart: false };
    case "REJECTED":
      return { label: "Not accepted", detail: "Your verification wasn't accepted. Contact support if you think this is a mistake.", tone: "bad", canStart: false };
    default: {
      const exhaustive: never = status;
      throw new Error(`Unknown verification status: ${String(exhaustive)}`);
    }
  }
}

const toneClass = {
  ok: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warn: "bg-amber-50 text-amber-900 ring-amber-200",
  bad: "bg-red-50 text-red-800 ring-red-200",
  neutral: "bg-stone-100 text-stone-700 ring-stone-200",
} as const;

export function IdentityStatusCard({ status }: { status: IdentityVerificationStatus | null }) {
  const copy = identityStatusCopy(status);
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-serif text-lg font-semibold">Identity verification</h2>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${toneClass[copy.tone]}`}>{copy.label}</span>
      </div>
      <p className="mt-2 text-sm text-stone-600">{copy.detail}</p>
      {copy.canStart && (
        <Link
          href="/account/verify"
          className="mt-4 inline-block rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700"
        >
          Verify my identity
        </Link>
      )}
      {status === "VERIFIED" && (
        <Link href="/sell" className="mt-4 inline-block text-sm font-medium underline">
          Go to selling
        </Link>
      )}
    </section>
  );
}
