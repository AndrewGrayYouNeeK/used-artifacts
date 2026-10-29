import { Suspense } from "react";
import { AuthCard } from "@/components/form";
import { VerifyEmailForm } from "./verify-email-form";

export default function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  return (
    <AuthCard title="Verify your email">
      <Suspense>
        <TokenGate searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

async function TokenGate({ searchParams }: { searchParams: PageProps<"/verify-email">["searchParams"] }) {
  const { token } = await searchParams;
  if (typeof token !== "string" || token.length === 0) {
    return <p className="text-sm text-red-800">This link is missing its token. Sign in to get a new one.</p>;
  }
  return <VerifyEmailForm token={token} />;
}
