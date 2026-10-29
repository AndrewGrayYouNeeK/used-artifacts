import "dotenv/config";
import { createDb } from "@/lib/db";
import { resetTwoFactorFromConsole } from "@/domains/identity/two-factor";

const email = process.env.RESET_EMAIL;
const reason = process.env.RESET_REASON;
if (!email || !reason || reason.trim().length < 10) {
  console.error("Set RESET_EMAIL and RESET_REASON (at least 10 characters, e.g. how the person's identity was confirmed).");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL!);

resetTwoFactorFromConsole(db, email, reason.trim())
  .then((found) => {
    if (!found) {
      console.error("No account with that email.");
      process.exitCode = 1;
      return;
    }
    console.info("Two-factor removed and every session signed out. The user signs in with their password and sets up a new authenticator.");
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
