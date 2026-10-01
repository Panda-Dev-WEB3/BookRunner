// Applies drizzle migrations, then Timescale hypertables (idempotent).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./index";

const { db, client, close } = createDb(undefined, 1);
try {
  await migrate(db, { migrationsFolder: resolve(import.meta.dir, "../migrations") });
  const timescale = readFileSync(resolve(import.meta.dir, "../sql/timescale.sql"), "utf8");
  await client.unsafe(timescale);
  console.log("migrations applied (drizzle + timescale)");
} finally {
  await close();
}
