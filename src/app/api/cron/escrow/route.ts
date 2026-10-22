import { connection } from "next/server";
import { liftExpiredSuspensions } from "@/domains/admin/enforcement";
import { runReferralJobs } from "@/domains/growth/referrals";
import { runEscrowJobs } from "@/domains/orders/jobs";
import { authorizedCron } from "@/lib/cron";
import { ordersDeps } from "@/lib/payments/orders-deps";

/** Escrow timers (payment window, ship-by deadline, auto-release, transfer/refund retries), suspension expiry, and referral payouts. */
export async function GET(request: Request) {
  await connection();
  if (!authorizedCron(request)) return new Response("Unauthorized", { status: 401 });
  const deps = ordersDeps();
  const escrow = await runEscrowJobs(deps);
  const suspensionsEnded = await liftExpiredSuspensions(deps);
  const referrals = await runReferralJobs(deps);
  return Response.json({ ...escrow, suspensionsEnded, referrals });
}
