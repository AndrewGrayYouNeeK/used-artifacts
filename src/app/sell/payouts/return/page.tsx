import { refreshPayoutsAction } from "@/app/actions/orders";
import { AuthCard } from "@/components/form";

export default function PayoutsReturnPage() {
  return (
    <AuthCard title="Payout setup">
      <p className="text-sm text-stone-600">
        Thanks. Stripe may take a minute to confirm your details. Your storefront page shows when payouts are on.
      </p>
      <form action={refreshPayoutsAction} className="mt-6">
        <button type="submit" className="w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white">
          Back to my storefront
        </button>
      </form>
    </AuthCard>
  );
}
