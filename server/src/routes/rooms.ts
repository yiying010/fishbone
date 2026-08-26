import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.ts";
import { SnapshotError, assertSnapshot, withoutNul } from "../domain/snapshot.ts";
import {
  RoomCodeFormatError,
  formatRoomCode,
  normalizeAdminRoomCode,
  normalizeRoomCode,
} from "../rooms/codes.ts";
import {
  RoomCodeError,
  RoomNotFoundError,
  normalizeMemberId,
  type AuthenticatedMember,
  type RoomStore,
} from "../rooms/store.ts";
import type { RoomNotifier } from "../rooms/notifier.ts";
import type { RateLimiter } from "../rate-limit.ts";
import {
  AiProviderError,
  AiRateLimitError,
  AiRequestError,
  extractAiInput,
  parseAiTask,
  type AiReviewService,
} from "../ai/review.ts";

export interface Limiters {
  /** Everything under /api, per client address. Generous; only bounds a single source. */
  requests: RateLimiter | null;
  /** Failed room lookups, per client address. This is the one that stops enumeration. */
  lookupFailures: RateLimiter | null;
  /** Room creation, per client address. */
  roomCreates: RateLimiter | null;
}

interface Deps {
  config: AppConfig;
  store: RoomStore;
  notifier: RoomNotifier;
  limiters: Limiters;
  aiService: AiReviewService | null;
}

const MAX_DISPLAY_NAME = 64;

/**
 * The single answer given whenever a caller does not hold a valid session for a
 * room, whether the room is missing, the token is wrong, or the token expired.
 * It carries no room code and no detail, because the difference between those
 * cases is exactly what a scan of the code space would be looking for.
 */
const NOT_FOUND = Object.freeze({ error: "room_not_found" });

export function registerRoomRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, store, notifier, limiters } = deps;

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

  const bearer = (request: FastifyRequest): string => {
    const header = request.headers["authorization"];
    return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  };

  const tooMany = (reply: FastifyReply, retryAfterSeconds: number) => {
    reply.code(429).header("retry-after", String(retryAfterSeconds)).header("cache-control", "no-store");
    return { error: "rate_limited", retryAfterSeconds };
  };

  /**
   * Spends one unit of the failed-lookup budget and answers. Over budget the
   * answer is 429 instead of 404, which still says nothing about whether the
   * room exists.
   */
  const notFound = (request: FastifyRequest, reply: FastifyReply) => {
    const spent = limiters.lookupFailures?.take(request.ip);
    if (spent && !spent.allowed) return tooMany(reply, spent.retryAfterSeconds);
    reply.code(404).header("cache-control", "no-store");
    return NOT_FOUND;
  };

  /**
   * Runs before anything touches the database.
   *
   * The failed-lookup budget is only pre-checked for callers that present no
   * token at all. A whole class shares one school NAT address, so pre-checking
   * it for everyone would let one student's typos lock their classmates out of
   * a room they are already in. A caller holding a valid session is never
   * turned away by that budget; one holding a junk token pays for a lookup and
   * then meets the budget on the way out.
   */
  const gate = (request: FastifyRequest, reply: FastifyReply): object | null => {
    const overall = limiters.requests?.take(request.ip);
    if (overall && !overall.allowed) return tooMany(reply, overall.retryAfterSeconds);
    if (bearer(request) === "") {
      const failures = limiters.lookupFailures?.peek(request.ip);
      if (failures && !failures.allowed) return tooMany(reply, failures.retryAfterSeconds);
    }
    return null;
  };

  /**
   * Resolves the room code and the caller's session together, because every
   * failure among them has to look the same from outside.
   */
  const authenticate = async (
    request: FastifyRequest,
  ): Promise<{ roomCode: string; member: AuthenticatedMember } | null> => {
    const roomCode = normalizeRoomCode((request.params as { code?: string }).code);
    const member = await store.authenticate(roomCode, bearer(request), config.sessionTtlHours);
    return member === null ? null : { roomCode, member };
  };

  /**
   * Creates a room and hands back its code. Rooms exist only because of this
   * route: joining an unknown code fails rather than bringing one into being,
   * so no code is ever chosen by a person.
   */
  app.post("/api/rooms", async (request, reply) => {
    const overall = limiters.requests?.take(request.ip);
    if (overall && !overall.allowed) return tooMany(reply, overall.retryAfterSeconds);
    const creates = limiters.roomCreates?.take(request.ip);
    if (creates && !creates.allowed) return tooMany(reply, creates.retryAfterSeconds);

    const code = await store.createRoom(config.roomCodeLength);
    reply.code(201).header("cache-control", "no-store");
    return { room: code, displayCode: formatRoomCode(code) };
  });

  app.post("/api/rooms/:code/join", async (request, reply) => {
    const limited = gate(request, reply);
    if (limited) return limited;

    const roomCode = normalizeRoomCode((request.params as { code?: string }).code);
    const payload = body(request);
    const memberId = normalizeMemberId(payload["memberId"]);

    const joined = await store.join(
      roomCode,
      memberId,
      displayName(payload["name"]),
      step(payload["step"]),
      config.sessionTtlHours,
    );
    if (joined === null) return notFound(request, reply);

    reply.header("cache-control", "no-store");
    return { room: roomCode, memberId, ...joined };
  });

  app.get("/api/rooms/:code/state", async (request, reply) => {
    const limited = gate(request, reply);
    if (limited) return limited;

    const session = await authenticate(request);
    if (session === null) return notFound(request, reply);
    const { roomCode, member } = session;

    const query = request.query as { since?: string; wait?: string; step?: string };
    const since = Number.parseInt(query.since ?? "", 10);
    const hasSince = Number.isFinite(since);
    const wantsHold = query.wait === "1" && config.longPollMs > 0;

    if (query.step !== undefined) {
      // Recording progress is secondary to showing the room. If it fails, the
      // student should still see their group's work rather than a 500.
      await store
        .touchMember(roomCode, member.memberId, step(query.step))
        .catch((error: unknown) => request.log.warn({ err: error }, "touchMember failed; serving state anyway"));
    }

    reply.header("cache-control", "no-store");
    // Stops an intermediate nginx from buffering a held response.
    reply.header("x-accel-buffering", "no");

    const first = await store.read(roomCode);
    if (first === null) return notFound(request, reply);
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
    if (latest === null) return notFound(request, reply);
    return { room: roomCode, ...latest };
  });

  app.post("/api/rooms/:code/state", async (request, reply) => {
    const limited = gate(request, reply);
    if (limited) return limited;

    const session = await authenticate(request);
    if (session === null) return notFound(request, reply);
    const { roomCode, member } = session;

    const payload = body(request);
    const baseRevision = Math.trunc(Number(payload["baseRevision"]));
    if (!Number.isFinite(baseRevision) || baseRevision < 0) {
      reply.code(400);
      return { error: "bad_request", message: "baseRevision must be a non-negative integer" };
    }
    const snapshot = assertSnapshot(payload["snapshot"], config.maxSnapshotBytes);

    // The author is the authenticated member, never whatever the body claims.
    const result = await store.write(roomCode, member.memberId, step(payload["step"]), baseRevision, snapshot);
    reply.header("cache-control", "no-store");

    if (result.status === "conflict") {
      // Not an error: the client merges what it gets back and posts again.
      reply.code(409);
      return { room: roomCode, ...result };
    }

    notifier.notify(roomCode, result.revision);
    return { room: roomCode, ...result };
  });

  app.post("/api/rooms/:code/ai/review", async (request, reply) => {
    const limited = gate(request, reply);
    if (limited) return limited;

    const session = await authenticate(request);
    if (session === null) return notFound(request, reply);
    const { roomCode, member } = session;
    reply.header("cache-control", "no-store");

    if (deps.aiService === null) {
      reply.code(503);
      return { error: "ai_unavailable", message: "AI assistance is not enabled." };
    }

    const payload = body(request);
    const baseRevision = Math.trunc(Number(payload["baseRevision"]));
    if (!Number.isFinite(baseRevision) || baseRevision < 0) {
      reply.code(400);
      return { error: "invalid_base_revision", message: "baseRevision must be a non-negative integer" };
    }

    const room = await store.read(roomCode);
    if (room === null) return notFound(request, reply);
    if (room.revision !== baseRevision) {
      reply.code(409);
      return { error: "stale_room_revision", revision: room.revision };
    }

    try {
      const task = parseAiTask(payload["task"]);
      const input = extractAiInput(task, payload["itemId"], room.snapshot, member.memberId, config.aiMaxInputChars);
      const reviewed = await deps.aiService.review(member.roomId, member.memberId, input);
      // The provider call may finish after another member edits the room. Do
      // not hand a now-stale result to the browser as if it still matched the
      // authoritative snapshot; the caller can refresh and request it again.
      // Only the revision number is needed here, not the full snapshot.
      const latestRevision = await store.readRevision(roomCode);
      if (latestRevision === null) return notFound(request, reply);
      if (latestRevision !== baseRevision) {
        request.log.info(
          { task, correlationId: reviewed.inputHash.slice(0, 16), outcome: "stale_after_provider" },
          "AI review discarded",
        );
        reply.code(409);
        return { error: "stale_room_revision", revision: latestRevision };
      }
      request.log.info(
        {
          task,
          correlationId: reviewed.inputHash.slice(0, 16),
          providerRequestId: reviewed.metadata.providerRequestId,
          promptVersion: reviewed.promptVersion,
          model: reviewed.metadata.model,
          latencyMs: reviewed.metadata.latencyMs,
          inputTokens: reviewed.metadata.inputTokens,
          outputTokens: reviewed.metadata.outputTokens,
          outcome: "success",
        },
        "AI review completed",
      );
      return {
        task,
        baseRevision,
        inputHash: reviewed.inputHash,
        promptVersion: reviewed.promptVersion,
        result: reviewed.result,
      };
    } catch (error) {
      if (error instanceof AiRequestError) {
        reply.code(error.code === "ai_item_forbidden" ? 403 : 400);
        return { error: error.code, message: "The requested AI review cannot be performed." };
      }
      if (error instanceof AiRateLimitError) {
        request.log.info({ outcome: "rate_limited" }, "AI review refused");
        reply
          .code(429)
          .header("retry-after", String(error.retryAfterSeconds))
          .header("cache-control", "no-store");
        return { error: "ai_rate_limited", retryAfterSeconds: error.retryAfterSeconds };
      }
      if (error instanceof AiProviderError) {
        const invalid = error.kind === "invalid_output";
        request.log.warn({ outcome: error.kind }, "AI review failed");
        reply.code(invalid ? 502 : 503);
        return {
          error: invalid ? "ai_invalid_output" : "ai_temporarily_unavailable",
          message: "AI assistance is temporarily unavailable. Please try again or continue manually.",
        };
      }
      throw error;
    }
  });

  app.post("/api/rooms/:code/artifacts", async (request, reply) => {
    const limited = gate(request, reply);
    if (limited) return limited;

    const session = await authenticate(request);
    if (session === null) return notFound(request, reply);
    const { roomCode, member } = session;

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
      exportedBy: member.memberId,
    });
    reply.code(201).header("cache-control", "no-store");
    return { room: roomCode, ...saved };
  });

  registerAdminRoutes(app, deps);

  app.setErrorHandler((error, _request, reply) => {
    // 404 rather than 400 so that a client writing to a room that was deleted
    // or purged gets the same signal as one reading it, and can stop instead of
    // retrying a request that can never succeed. The body stays the shared one:
    // error.message is never sent, because it would separate "gone" from
    // "never existed".
    if (error instanceof RoomNotFoundError) {
      reply.code(404);
      return reply.send(NOT_FOUND);
    }
    if (error instanceof RoomCodeFormatError) {
      // A code that is not even the right shape says nothing about which rooms
      // exist, so this one may explain itself: a student needs to know they
      // mistyped rather than being told the room is gone.
      reply.code(400);
      return reply.send({ error: "bad_room_code", message: error.message });
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
 * whole class's work to anyone holding a room code.
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
    const roomCode = normalizeAdminRoomCode((request.params as { code?: string }).code);
    const data = await store.exportRoom(roomCode);
    if (data === null) {
      reply.code(404);
      return NOT_FOUND;
    }
    reply.header("cache-control", "no-store");
    return data;
  });

  app.delete("/api/admin/rooms/:code", async (request, reply) => {
    if (!authorize(request, reply)) return reply;
    const roomCode = normalizeAdminRoomCode((request.params as { code?: string }).code);
    const deleted = await store.deleteRoom(roomCode);
    reply.code(deleted ? 200 : 404);
    return { room: roomCode, deleted };
  });
}
