import type { FastifyRequest } from "fastify";
import type { RoomRouteDeps } from "./room-context.ts";

/**
 * Waits until a room revision changes, the client disconnects, or the request
 * reaches its long-poll deadline. The database probe detects writes made by a
 * different server replica.
 */
export async function holdUntilRoomChanges(
  request: FastifyRequest,
  roomCode: string,
  since: number,
  { config, store, notifier }: RoomRouteDeps,
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
