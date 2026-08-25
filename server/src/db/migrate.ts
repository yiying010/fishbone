import { migrations } from "./migrations.ts";
import type { Pool } from "./pool.ts";

export interface MigrationLogger {
  info(message: string): void;
}

/**
 * Applies pending migrations. A Postgres advisory lock makes it safe for
 * several replicas to start at once: the losers block, then find nothing to do.
 */
export async function runMigrations(pool: Pool, logger: MigrationLogger): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      create table if not exists schema_migrations (
        id          text        primary key,
        applied_at  timestamptz not null default now()
      )
    `);

    // Arbitrary but fixed key, namespaced to this application.
    await client.query("select pg_advisory_lock($1)", [7_351_209_884_113_001]);
    try {
      const { rows } = await client.query<{ id: string }>("select id from schema_migrations");
      const done = new Set(rows.map((row) => row.id));

      for (const migration of migrations) {
        if (done.has(migration.id)) continue;
        logger.info(`applying migration ${migration.id}`);
        await client.query("begin");
        try {
          await client.query(migration.sql);
          await client.query("insert into schema_migrations (id) values ($1)", [migration.id]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw new Error(`migration ${migration.id} failed: ${(error as Error).message}`, { cause: error });
        }
        applied.push(migration.id);
      }
    } finally {
      await client.query("select pg_advisory_unlock($1)", [7_351_209_884_113_001]);
    }
  } finally {
    client.release();
  }

  logger.info(applied.length === 0 ? "database schema already up to date" : `applied ${applied.length} migration(s)`);
  return applied;
}
