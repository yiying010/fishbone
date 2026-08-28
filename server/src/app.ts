import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "./config.ts";
import type { Pool } from "./db/pool.ts";
import { RateLimiter } from "./rate-limit.ts";
import { RoomNotifier } from "./rooms/notifier.ts";
import { RoomStore } from "./rooms/store.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerRoomRoutes, type Limiters } from "./routes/rooms.ts";
import { AiReviewService, OpenAiReviewClient } from "./ai/review.ts";

export function defaultPublicDir(): string {
  // build/app.js -> repo root -> public
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}

/**
 * Replaces the room code in a path with a placeholder.
 *
 * A room code is the only thing standing between an outsider and a class's
 * writing, so it must not reach a log file, a log shipper or a crash report.
 * The query string goes too: it carries the member's step and, historically,
 * their member id.
 */
export function redactPath(url: string): string {
  const path = url.split("?")[0] ?? "/";
  return path
    .replace(/^(\/api\/rooms\/)[^/]+/, "$1:code")
    .replace(/^(\/api\/admin\/rooms\/)[^/]+/, "$1:code");
}

export function createLimiters(config: AppConfig): Limiters {
  if (!config.rateLimitEnabled) {
    return { requests: null, lookupFailures: null, roomCreates: null };
  }
  return {
    requests: new RateLimiter({
      capacity: config.rateLimitRequestsPerMinute,
      refillPeriodMs: 60_000,
    }),
    lookupFailures: new RateLimiter({
      capacity: config.rateLimitLookupFailuresPerMinute,
      refillPeriodMs: 60_000,
    }),
    roomCreates: new RateLimiter({
      capacity: config.rateLimitRoomCreatesPerHour,
      refillPeriodMs: 3_600_000,
    }),
  };
}

declare module "fastify" {
  interface FastifyInstance {
    limiters: Limiters;
  }
}

export async function buildApp(config: AppConfig, pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        // Belt and braces: nothing should log `req` now that request logging is
        // off, but if something does, it must not carry a room code.
        req(request: { method: string; url: string }) {
          return { method: request.method, url: redactPath(request.url ?? "/") };
        },
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    /**
     * Fastify's built-in request and response lines log the raw URL, which for
     * this service is `/api/rooms/<the room code>/state?...`. That is the
     * credential to a room full of children's writing sitting in a log file, so
     * the built-in logging is off and the hook below records the route pattern.
     */
    disableRequestLogging: true,
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

  app.addHook("onResponse", (request, reply, done) => {
    app.log.info(
      {
        method: request.method,
        // The matched route pattern, so `:code` stays a placeholder.
        route: request.routeOptions.url ?? redactPath(request.url),
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
      },
      "request completed",
    );
    done();
  });

  const store = new RoomStore(pool, config.memberAbsentAfterSeconds);
  const notifier = new RoomNotifier();
  const limiters = createLimiters(config);
  const aiService = config.aiEnabled && config.openAiApiKey !== null
    ? new AiReviewService({
        client: new OpenAiReviewClient({
          apiKey: config.openAiApiKey,
          model: config.openAiModel,
          timeoutMs: config.aiTimeoutMs,
          maxOutputTokens: config.aiMaxOutputTokens,
        }),
        requestsPerMemberPerMinute: config.aiRequestsPerMemberPerMinute,
      })
    : null;
  app.decorate("limiters", limiters);

  registerHealthRoutes(app, pool, Date.now());
  registerRoomRoutes(app, { config, store, notifier, limiters, aiService });

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
