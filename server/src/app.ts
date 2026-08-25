import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "./config.js";
import type { Pool } from "./db/pool.js";
import { RoomNotifier } from "./rooms/notifier.js";
import { RoomStore } from "./rooms/store.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRoomRoutes } from "./routes/rooms.js";

export function defaultPublicDir(): string {
  // build/app.js -> repo root -> public
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}

export async function buildApp(config: AppConfig, pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    /**
     * `location /fishbone { proxy_pass http://app/; }` — a prefix written
     * without its trailing slash — makes nginx forward `//api/rooms/...` with a
     * doubled leading slash, which would otherwise route to nothing and give
     * the operator a 404 with no explanation. Verified against nginx 1.27.
     */
    rewriteUrl(request) {
      const url = request.url ?? "/";
      return url.startsWith("//") ? url.replace(/^\/+/, "/") : url;
    },
  });

  const store = new RoomStore(pool);
  const notifier = new RoomNotifier();

  registerHealthRoutes(app, pool, Date.now());
  registerRoomRoutes(app, { config, store, notifier });

  await app.register(fastifyStatic, {
    root: config.publicDir,
    // Serving the activity as the directory index keeps every client-side URL
    // relative: the page never has to know which prefix it was mounted at.
    index: ["fishbone.html"],
    prefix: "/",
    // max-age=0 with an ETag means every load revalidates and usually gets a
    // 304. Caching the page for even a few minutes would leave a class running
    // a version of the activity that was replaced mid-lesson.
    cacheControl: true,
    maxAge: 0,
    etag: true,
  });

  return app;
}
