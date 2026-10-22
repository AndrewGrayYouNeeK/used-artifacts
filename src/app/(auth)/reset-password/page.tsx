import { Suspense } from "react";
import { AuthCard } from "@/components/form";
import { ResetPasswordForm } from "./reset-password-form";

export default function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  return (
    <AuthCard title="Choose a new password">
      <Suspense>
        <TokenGate searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

async function TokenGate({ searchParams }: { searchParams: PageProps<"/reset-password">["searchParams"] }) {
  const { token } = await searchParams;
  if (typeof token !== "string" || token.length === 0) {
    return <p className="text-sm text-red-800">This reset link is missing its token. Request a new one.</p>;
  }
  return <ResetPasswordForm token={token} />;
}
