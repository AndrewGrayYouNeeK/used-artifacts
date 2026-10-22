import { connection } from "next/server";
import { runEscrowJobs } from "@/domains/orders/jobs";
import { authorizedCron } from "@/lib/cron";
import { ordersDeps } from "@/lib/payments/orders-deps";

/** Escrow timers (payment window, ship-by deadline, auto-release, transfer/refund retries). */
export async function GET(request: Request) {
  await connection();
  if (!authorizedCron(request)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await runEscrowJobs(ordersDeps()));
}
