import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.ts";
import { SnapshotError } from "../domain/snapshot.ts";
import { RoomCodeFormatError } from "../rooms/codes.ts";
import {
  MemberIdentityError,
  RoomCapacityError,
  RoomCodeError,
  RoomNotFoundError,
} from "../rooms/errors.ts";
import { ROOM_NOT_FOUND } from "./room-context.ts";

/** Maps domain and transport failures to the room API's stable public contract. */
export function registerRoomErrorHandler(app: FastifyInstance, config: AppConfig): void {
  app.setErrorHandler((error, _request, reply) => {
    // 404 rather than 400 so that a client writing to a room that was deleted
    // or purged gets the same signal as one reading it, and can stop instead of
    // retrying a request that can never succeed. The body stays the shared one:
    // error.message is never sent, because it would separate "gone" from
    // "never existed".
    if (error instanceof RoomNotFoundError) {
      reply.code(404);
      return reply.send(ROOM_NOT_FOUND);
    }
    if (error instanceof RoomCodeFormatError) {
      reply.code(400);
      return reply.send({ error: "bad_room_code", message: error.message });
    }
    if (error instanceof RoomCodeError || error instanceof SnapshotError) {
      if (error instanceof SnapshotError) app.log.warn({ validationError: error.message }, "invalid room snapshot");
      reply.code(400);
      return reply.send({ error: "bad_request", message: error.message });
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      reply.code(413);
      return reply.send({ error: "payload_too_large", limitBytes: config.bodyLimitBytes });
    }
    if (error instanceof MemberIdentityError) {
      reply.code(409);
      return reply.send({ error: "member_id_in_use" });
    }
    if (error instanceof RoomCapacityError) {
      reply.code(409);
      return reply.send({ error: "room_full_or_locked" });
    }
    app.log.error({ err: error }, "request failed");
    reply.code(500);
    return reply.send({ error: "internal_error" });
  });
}
