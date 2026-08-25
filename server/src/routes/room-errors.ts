import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.ts";
import { SnapshotError } from "../domain/snapshot.ts";
import { RoomCodeFormatError } from "../rooms/codes.ts";
import { RoomCodeError, RoomNotFoundError } from "../rooms/errors.ts";
import { ROOM_NOT_FOUND } from "./room-context.ts";

/** Maps domain and transport failures to the room API's stable public contract. */
export function registerRoomErrorHandler(app: FastifyInstance, config: AppConfig): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RoomNotFoundError) {
      reply.code(404);
      return reply.send(ROOM_NOT_FOUND);
    }
    if (error instanceof RoomCodeFormatError) {
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
