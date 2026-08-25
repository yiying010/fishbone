import type { RoomStore } from "./rooms/store.ts";

export interface RetentionLogger {
  info(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * Deletes rooms whose last activity is older than the configured retention
 * period. This is a real `delete`, not a flag: after a sweep the room is gone
 * from the live database, and the only remaining copy is whatever backups the
 * operator keeps (see the retention section of the README).
 */
export function startRetentionSweeper(
  store: RoomStore,
  logger: RetentionLogger,
  options: { retentionDays: number; intervalMinutes: number },
): { stop: () => void; runOnce: () => Promise<number> } {
  const runOnce = async (): Promise<number> => {
    const { deletedRooms } = await store.purgeExpired(options.retentionDays);
    if (deletedRooms > 0) {
      logger.info({ deletedRooms, retentionDays: options.retentionDays }, "retention sweep deleted expired rooms");
    }
    return deletedRooms;
  };

  const tick = () => {
    runOnce().catch((error: unknown) => {
      logger.error({ err: error }, "retention sweep failed");
    });
  };

  // Run once at startup so an operator who shortens the period sees it applied
  // without waiting a whole interval.
  tick();
  const timer = setInterval(tick, options.intervalMinutes * 60_000);
  timer.unref();

  return { stop: () => clearInterval(timer), runOnce };
}
