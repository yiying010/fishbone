/** `npm run migrate` — apply pending migrations and exit. */
import { defaultPublicDir } from "../app.js";
import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import { createPool } from "../db/pool.js";

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
