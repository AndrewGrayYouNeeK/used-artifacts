import { startPayoutOnboardingAction } from "@/app/actions/orders";
import { ActionForm } from "@/components/action-form";
import { AuthCard } from "@/components/form";

export default function PayoutsRefreshPage() {
  return (
    <AuthCard title="Payout setup link expired">
      <p className="mb-6 text-sm text-stone-600">Setup links are single-use. Start again to get a fresh one.</p>
      <ActionForm action={startPayoutOnboardingAction} submitLabel="Continue payout setup" />
    </AuthCard>
  );
}
