import { Suspense } from "react";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth/dal";
import { FeedbackForm } from "./feedback-form";

export default function FeedbackPage() {
  return (
    <div className="mx-auto max-w-xl px-6 py-12">
      <h1 className="font-serif text-3xl font-semibold">Beta feedback</h1>
      <p className="mt-2 text-sm text-stone-600">
        Tell us what&apos;s broken, confusing, or missing. Trust and safety concerns go straight to the daily staff review.
      </p>
      <Suspense fallback={<div className="mt-6 h-64 animate-pulse rounded-2xl bg-stone-100" />}>
        <FeedbackDetails />
      </Suspense>
    </div>
  );
}

async function FeedbackDetails() {
  await requireUser();
  const referer = (await headers()).get("referer");
  let from = "";
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.pathname !== "/feedback") from = url.pathname;
    } catch {
      from = "";
    }
  }
  return <FeedbackForm from={from} />;
}
