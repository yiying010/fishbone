import { buildApp, defaultPublicDir } from "./app.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { startRetentionSweeper } from "./retention.js";
import { RoomStore } from "./rooms/store.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env["PUBLIC_DIR"]?.trim() || defaultPublicDir());
  const pool = createPool(config);

  if (config.migrateOnStart) {
    await runMigrations(pool, { info: (message) => console.log(`[migrate] ${message}`) });
  }

  const app = await buildApp(config, pool);

  const sweeper = startRetentionSweeper(new RoomStore(pool), app.log, {
    retentionDays: config.dataRetentionDays,
    intervalMinutes: config.retentionSweepIntervalMinutes,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    sweeper.stop();
    try {
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      dataRetentionDays: config.dataRetentionDays,
      longPollMs: config.longPollMs,
      adminRoutes: config.adminToken !== null,
    },
    "fishbone room server ready",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
