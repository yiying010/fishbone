import type { FastifyInstance } from "fastify";
import type { Pool } from "../db/pool.ts";

/**
 * A liveness probe that cannot fail proves nothing, so this one actually
 * touches the database and reports 503 when the query does not come back.
 */
export function registerHealthRoutes(app: FastifyInstance, pool: Pool, startedAt: number): void {
  app.get("/healthz", async (_request, reply) => {
    const began = process.hrtime.bigint();
    try {
      const client = await pool.connect();
      try {
        // A trivial read against a real table: catches "connected but the
        // schema is missing", which `select 1` would happily call healthy.
        await client.query("select count(*) from schema_migrations");
      } finally {
        client.release();
      }
    } catch (error) {
      reply.code(503);
      return {
        status: "unhealthy",
        database: "unreachable",
        error: (error as Error).message,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      };
    }

    const latencyMs = Number(process.hrtime.bigint() - began) / 1e6;
    return {
      status: "ok",
      database: "ok",
      databaseLatencyMs: Math.round(latencyMs * 100) / 100,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
  });
}
