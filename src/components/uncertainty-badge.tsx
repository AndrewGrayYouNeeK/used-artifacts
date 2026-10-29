import type { AiUncertainty } from "@/generated/prisma/enums";

const STYLES: Record<AiUncertainty, { label: string; className: string }> = {
  LOW: { label: "Low uncertainty", className: "bg-emerald-100 text-emerald-900" },
  MEDIUM: { label: "Medium uncertainty", className: "bg-amber-100 text-amber-900" },
  HIGH: { label: "High uncertainty", className: "bg-red-100 text-red-900" },
};

export function UncertaintyBadge({ uncertainty }: { uncertainty: AiUncertainty }) {
  const style = STYLES[uncertainty];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>{style.label}</span>;
}
