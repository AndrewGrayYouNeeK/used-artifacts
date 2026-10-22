import { connection } from "next/server";
import { runAuctionJobs } from "@/domains/auctions/auctions";
import { liftExpiredSuspensions } from "@/domains/admin/enforcement";
import { sendDailyDigest } from "@/domains/admin/daily-review";
import { serverEnv } from "@/config/env";
import { runReferralJobs } from "@/domains/growth/referrals";
import { runEscrowJobs } from "@/domains/orders/jobs";
import { runCircleTradeScan } from "@/domains/trust/circle-trade";
import { authorizedCron } from "@/lib/cron";
import { auctionDeps } from "@/lib/payments/orders-deps";
import { getMailer } from "@/lib/email/mailer";

/**
 * Escrow timers (payment window, ship-by deadline, auto-release, transfer/refund retries),
 * auction closes and non-payments (after escrow, which expires unpaid orders),
 * suspension expiry, referral payouts, the nightly circle-trade scan, and the daily staff digest.
 */
export async function GET(request: Request) {
  await connection();
  if (!authorizedCron(request)) return new Response("Unauthorized", { status: 401 });
  const deps = auctionDeps();
  const escrow = await runEscrowJobs(deps);
  const auctions = await runAuctionJobs(deps);
  const suspensionsEnded = await liftExpiredSuspensions(deps);
  const referrals = await runReferralJobs(deps);
  const circleTrades = await runCircleTradeScan(deps);
  const digest = await sendDailyDigest({ db: deps.db, mailer: getMailer(), appUrl: serverEnv().APP_URL });
  return Response.json({ ...escrow, auctions, suspensionsEnded, referrals, circleTrades, digest });
}
