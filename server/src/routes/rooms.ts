import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.ts";
import { SnapshotError, assertSnapshot, withoutNul } from "../domain/snapshot.ts";
import {
  RoomCodeError,
  RoomNotFoundError,
  normalizeMemberId,
  normalizeRoomCode,
  type RoomStore,
} from "../rooms/store.ts";
import type { RoomNotifier } from "../rooms/notifier.ts";

interface Deps {
  config: AppConfig;
  store: RoomStore;
  notifier: RoomNotifier;
}

const MAX_DISPLAY_NAME = 64;

export function registerRoomRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, store, notifier } = deps;

  const code = (request: FastifyRequest): string =>
    normalizeRoomCode((request.params as { code?: string }).code, config.roomCodeMaxLength);

  const body = (request: FastifyRequest): Record<string, unknown> => {
    const value = request.body;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RoomCodeError("request body must be a JSON object");
    }
    return value as Record<string, unknown>;
  };

  const step = (value: unknown): number => {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) ? Math.min(19, Math.max(0, parsed)) : 0;
  };

  const displayName = (value: unknown): string =>
    typeof value === "string" ? withoutNul(value).trim().slice(0, MAX_DISPLAY_NAME) : "";

  app.post("/api/rooms/:code/join", async (request, reply) => {
    const roomCode = code(request);
    const payload = body(request);
    const memberId = normalizeMemberId(payload["memberId"]);
    const state = await store.join(roomCode, memberId, displayName(payload["name"]), step(payload["step"]));
    reply.header("cache-control", "no-store");
    return { room: roomCode, memberId, ...state };
  });

  app.get("/api/rooms/:code/state", async (request, reply) => {
    const roomCode = code(request);
    const query = request.query as { since?: string; wait?: string; member?: string; step?: string };
    const since = Number.parseInt(query.since ?? "", 10);
    const hasSince = Number.isFinite(since);
    const wantsHold = query.wait === "1" && config.longPollMs > 0;

    if (typeof query.member === "string" && query.member.trim() !== "") {
      // Recording presence is secondary to showing the room. If it fails, the
      // student should still see their group's work rather than a 500.
      await store
        .touchMember(roomCode, normalizeMemberId(query.member), step(query.step))
        .catch((error: unknown) => request.log.warn({ err: error }, "touchMember failed; serving state anyway"));
    }

    reply.header("cache-control", "no-store");
    // Stops an intermediate nginx from buffering a held response.
    reply.header("x-accel-buffering", "no");

    const first = await store.read(roomCode);
    if (first === null) {
      reply.code(404);
      return { error: "room_not_found", room: roomCode };
    }
    if (!hasSince || first.revision !== since) {
      return { room: roomCode, ...first };
    }
    if (!wantsHold) {
      return { room: roomCode, revision: first.revision, currentStep: first.currentStep, unchanged: true };
    }

    const changed = await holdUntilChanged(request, roomCode, since, deps);
    if (!changed) {
      return { room: roomCode, revision: since, currentStep: first.currentStep, unchanged: true };
    }
    const latest = await store.read(roomCode);
    if (latest === null) {
      reply.code(404);
      return { error: "room_not_found", room: roomCode };
    }
    return { room: roomCode, ...latest };
  });

  app.post("/api/rooms/:code/state", async (request, reply) => {
    const roomCode = code(request);
    const payload = body(request);
    const memberId = payload["memberId"] === undefined ? null : normalizeMemberId(payload["memberId"]);
    const baseRevision = Math.trunc(Number(payload["baseRevision"]));
    if (!Number.isFinite(baseRevision) || baseRevision < 0) {
      reply.code(400);
      return { error: "bad_request", message: "baseRevision must be a non-negative integer" };
    }
    const snapshot = assertSnapshot(payload["snapshot"], config.maxSnapshotBytes);

    const result = await store.write(roomCode, memberId, step(payload["step"]), baseRevision, snapshot);
    reply.header("cache-control", "no-store");

    if (result.status === "conflict") {
      // Not an error: the client merges what it gets back and posts again.
      reply.code(409);
      return { room: roomCode, ...result };
    }

    notifier.notify(roomCode, result.revision);
    return { room: roomCode, ...result };
  });

  app.post("/api/rooms/:code/artifacts", async (request, reply) => {
    const roomCode = code(request);
    const payload = body(request);
    const format = String(payload["format"] ?? "").trim().toLowerCase();
    if (!["text", "svg"].includes(format)) {
      reply.code(400);
      return { error: "bad_request", message: "format must be 'text' or 'svg'" };
    }
    const content = typeof payload["content"] === "string" ? withoutNul(payload["content"]) : "";
    if (content === "") {
      reply.code(400);
      return { error: "bad_request", message: "content must be a non-empty string" };
    }
    if (Buffer.byteLength(content, "utf8") > config.maxArtifactBytes) {
      reply.code(413);
      return { error: "artifact_too_large", limitBytes: config.maxArtifactBytes };
    }

    const saved = await store.saveArtifact(roomCode, {
      format,
      filename: typeof payload["filename"] === "string" ? withoutNul(payload["filename"]).slice(0, 200) : "",
      content,
      exportedBy: payload["memberId"] === undefined ? null : normalizeMemberId(payload["memberId"]),
    });
    reply.code(201).header("cache-control", "no-store");
    return { room: roomCode, ...saved };
  });

  registerAdminRoutes(app, deps);

  app.setErrorHandler((error, _request, reply) => {
    // 404 rather than 400 so that a client writing to a room that was deleted
    // or purged gets the same signal as one reading it, and can stop instead of
    // retrying a request that can never succeed.
    if (error instanceof RoomNotFoundError) {
      reply.code(404);
      return reply.send({ error: "room_not_found", message: error.message });
    }
    if (error instanceof RoomCodeError || error instanceof SnapshotError) {
      reply.code(400);
      return reply.send({ error: "bad_request", message: error.message });
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      reply.code(413);
      return reply.send({ error: "payload_too_large", limitBytes: config.bodyLimitBytes });
    }
    app.log.error({ err: error }, "request failed");
    reply.code(500);
    return reply.send({ error: "internal_error" });
  });
}

/**
 * Holds the request until the room's revision moves away from `since`, the
 * client disconnects, or the long-poll budget runs out.
 *
 * It waits on the in-process notifier but re-probes the database at least once
 * a second, so a change written by another replica is still picked up.
 */
async function holdUntilChanged(
  request: FastifyRequest,
  roomCode: string,
  since: number,
  { config, store, notifier }: Deps,
): Promise<boolean> {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  request.raw.on("close", onClose);

  try {
    const deadline = Date.now() + config.longPollMs;
    while (!controller.signal.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await notifier.wait(roomCode, Math.min(1000, remaining), controller.signal);
      if (controller.signal.aborted) return false;
      const revision = await store.readRevision(roomCode);
      if (revision === null || revision !== since) return true;
    }
    return false;
  } finally {
    request.raw.off("close", onClose);
  }
}

/**
 * Export and delete are gated behind ADMIN_TOKEN. With no token configured the
 * routes do not exist at all, so a deployment cannot accidentally expose a
 * whole class's work to anyone who guessed a room code.
 */
function registerAdminRoutes(app: FastifyInstance, { config, store }: Deps): void {
  const token = config.adminToken;
  if (token === null) return;

  // Comparing fixed-length digests keeps the comparison constant time without
  // also leaking the token's length through an early return.
  const expected = createHash("sha256").update(token, "utf8").digest();

  const authorize = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const header = request.headers["authorization"];
    const provided = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const actual = createHash("sha256").update(provided, "utf8").digest();
    if (!timingSafeEqual(actual, expected)) {
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  app.get("/api/admin/rooms/:code/export", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const roomCode = normalizeRoomCode((request.params as { code?: string }).code, config.roomCodeMaxLength);
    const data = await store.exportRoom(roomCode);
    if (data === null) {
      reply.code(404);
      return { error: "room_not_found", room: roomCode };
    }
    reply.header("cache-control", "no-store");
    return data;
  });

  app.delete("/api/admin/rooms/:code", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const roomCode = normalizeRoomCode((request.params as { code?: string }).code, config.roomCodeMaxLength);
    const deleted = await store.deleteRoom(roomCode);
    reply.code(deleted ? 200 : 404);
    return { room: roomCode, deleted };
  });
}
