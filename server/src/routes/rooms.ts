import type { FastifyInstance } from "fastify";
import { assertSnapshot, withoutNul } from "../domain/snapshot.ts";
import { formatRoomCode, normalizeRoomCode } from "../rooms/codes.ts";
import { normalizeMemberId } from "../rooms/member-id.ts";
import { registerAdminRoomRoutes } from "./admin-rooms.ts";
import {
  authenticateRoom,
  displayName,
  gateRoomRequest,
  rateLimited,
  requestBody,
  roomNotFound,
  roomStep,
  type Limiters,
  type RoomRouteDeps,
} from "./room-context.ts";
import { registerRoomErrorHandler } from "./room-errors.ts";
import { holdUntilRoomChanges } from "./room-long-poll.ts";

export type { Limiters } from "./room-context.ts";

export function registerRoomRoutes(app: FastifyInstance, deps: RoomRouteDeps): void {
  const { config, store, notifier, limiters } = deps;

  /**
   * Creates a room and hands back its code. Rooms exist only because of this
   * route: joining an unknown code fails rather than bringing one into being,
   * so no code is ever chosen by a person.
   */
  app.post("/api/rooms", async (request, reply) => {
    const overall = limiters.requests?.take(request.ip);
    if (overall && !overall.allowed) return rateLimited(reply, overall.retryAfterSeconds);
    const creates = limiters.roomCreates?.take(request.ip);
    if (creates && !creates.allowed) return rateLimited(reply, creates.retryAfterSeconds);

    const code = await store.createRoom(config.roomCodeLength);
    reply.code(201).header("cache-control", "no-store");
    return { room: code, displayCode: formatRoomCode(code) };
  });

  app.post("/api/rooms/:code/join", async (request, reply) => {
    const limited = gateRoomRequest(request, reply, limiters);
    if (limited) return limited;

    const roomCode = normalizeRoomCode((request.params as { code?: string }).code);
    const payload = requestBody(request);
    const memberId = normalizeMemberId(payload["memberId"]);

    const joined = await store.join(
      roomCode,
      memberId,
      displayName(payload["name"]),
      roomStep(payload["step"]),
      config.sessionTtlHours,
    );
    if (joined === null) return roomNotFound(request, reply, limiters);

    reply.header("cache-control", "no-store");
    return { room: roomCode, memberId, ...joined };
  });

  app.get("/api/rooms/:code/state", async (request, reply) => {
    const limited = gateRoomRequest(request, reply, limiters);
    if (limited) return limited;

    const session = await authenticateRoom(request, deps);
    if (session === null) return roomNotFound(request, reply, limiters);
    const { roomCode, member } = session;

    const query = request.query as { since?: string; wait?: string; step?: string };
    const since = Number.parseInt(query.since ?? "", 10);
    const hasSince = Number.isFinite(since);
    const wantsHold = query.wait === "1" && config.longPollMs > 0;

    if (query.step !== undefined) {
      // Recording progress is secondary to showing the room. If it fails, the
      // student should still see their group's work rather than a 500.
      await store
        .touchMember(roomCode, member.memberId, roomStep(query.step))
        .catch((error: unknown) => request.log.warn({ err: error }, "touchMember failed; serving state anyway"));
    }

    reply.header("cache-control", "no-store");
    // Stops an intermediate nginx from buffering a held response.
    reply.header("x-accel-buffering", "no");

    const first = await store.read(roomCode);
    if (first === null) return roomNotFound(request, reply, limiters);
    if (!hasSince || first.revision !== since) {
      return { room: roomCode, ...first };
    }
    if (!wantsHold) {
      return { room: roomCode, revision: first.revision, currentStep: first.currentStep, unchanged: true };
    }

    const changed = await holdUntilRoomChanges(request, roomCode, since, deps);
    if (!changed) {
      return { room: roomCode, revision: since, currentStep: first.currentStep, unchanged: true };
    }
    const latest = await store.read(roomCode);
    if (latest === null) return roomNotFound(request, reply, limiters);
    return { room: roomCode, ...latest };
  });

  app.post("/api/rooms/:code/state", async (request, reply) => {
    const limited = gateRoomRequest(request, reply, limiters);
    if (limited) return limited;

    const session = await authenticateRoom(request, deps);
    if (session === null) return roomNotFound(request, reply, limiters);
    const { roomCode, member } = session;

    const payload = requestBody(request);
    const baseRevision = Math.trunc(Number(payload["baseRevision"]));
    if (!Number.isFinite(baseRevision) || baseRevision < 0) {
      reply.code(400);
      return { error: "bad_request", message: "baseRevision must be a non-negative integer" };
    }
    const snapshot = assertSnapshot(payload["snapshot"], config.maxSnapshotBytes);

    // The author is the authenticated member, never whatever the body claims.
    const result = await store.write(roomCode, member.memberId, roomStep(payload["step"]), baseRevision, snapshot);
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
    const limited = gateRoomRequest(request, reply, limiters);
    if (limited) return limited;

    const session = await authenticateRoom(request, deps);
    if (session === null) return roomNotFound(request, reply, limiters);
    const { roomCode, member } = session;

    const payload = requestBody(request);
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

  registerAdminRoomRoutes(app, deps);
  registerRoomErrorHandler(app, config);
}
