import pg from "pg";
import type { AppConfig } from "../config.ts";

// bigint (int8) arrives as a string by default because it can exceed
// Number.MAX_SAFE_INTEGER. Room revisions never will, and the client compares
// them numerically, so decode them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(config: AppConfig, onError?: (error: Error) => void): Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: config.dbConnectTimeoutMs,
    idleTimeoutMillis: 30_000,
    application_name: "fishbone-room-server",
  });

  // A database restart makes every idle client emit `error`. Without a listener
  // that is an unhandled event and the process dies, which would turn a
  // recoverable outage into a crash loop and make /healthz unreachable exactly
  // when it has something to report.
  pool.on("error", (error) => {
    if (onError) onError(error);
    else console.error(`[db] idle client error: ${error.message}`);
  });

  return pool;
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The connection is already broken; releasing it below discards it.
    }
    throw error;
  } finally {
    client.release();
  }
}
