import type { FeedbackCategory } from "@/generated/prisma/enums";

export const FEEDBACK_CATEGORIES: readonly { value: FeedbackCategory; label: string }[] = [
  { value: "BUG", label: "Something's broken" },
  { value: "IDEA", label: "Idea or request" },
  { value: "TRUST_SAFETY", label: "Trust or safety concern" },
  { value: "OTHER", label: "Something else" },
];
