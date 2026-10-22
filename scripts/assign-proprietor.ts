import "dotenv/config";
import { createDb } from "@/lib/db";
import { assignProprietor } from "@/domains/identity/proprietor";

const email = process.env.PROPRIETOR_EMAIL;
if (!email) {
  console.error("Set PROPRIETOR_EMAIL to the platform owner's verified account email.");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL!);

assignProprietor(db, email)
  .then((row) => console.info(`Proprietor badge permanently assigned to user ${row.userId}.`))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
