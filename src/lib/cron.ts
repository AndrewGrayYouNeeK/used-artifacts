import "server-only";
import { timingSafeEqual } from "node:crypto";
import { cronSecret } from "@/config/env";

/** Scheduled jobs authenticate with `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends it). */
export function authorizedCron(request: Request): boolean {
  const expected = Buffer.from(`Bearer ${cronSecret()}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
