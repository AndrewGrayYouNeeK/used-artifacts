import { execSync } from "node:child_process";
import { Client } from "pg";

/**
 * Rebuilds the test database from migrations before the integration suite.
 * DROP SCHEMA is used because the append-only and Proprietor triggers
 * (correctly) refuse DELETE/TRUNCATE.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("Integration tests need TEST_DATABASE_URL (a disposable Postgres database).");
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();

  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
}
