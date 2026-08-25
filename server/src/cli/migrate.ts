/** `npm run migrate` — apply pending migrations and exit. */
import { defaultPublicDir } from "../app.ts";
import { loadConfig } from "../config.ts";
import { runMigrations } from "../db/migrate.ts";
import { createPool } from "../db/pool.ts";

const config = loadConfig(defaultPublicDir());
const pool = createPool(config);

try {
  await runMigrations(pool, { info: (message) => console.log(`[migrate] ${message}`) });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
