import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeAdminRoomCode } from "../rooms/codes.ts";
import { ROOM_NOT_FOUND, type RoomRouteDeps } from "./room-context.ts";

/**
 * Registers privileged room export and deletion endpoints. When no admin token
 * is configured, the endpoints do not exist.
 */
export function registerAdminRoomRoutes(
  app: FastifyInstance,
  { config, store }: RoomRouteDeps,
): void {
  const token = config.adminToken;
  if (token === null) return;

  // Fixed-length digests avoid leaking the configured token's length.
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
      return ROOM_NOT_FOUND;
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
