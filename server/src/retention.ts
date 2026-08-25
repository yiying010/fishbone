import type { RoomStore } from "./rooms/store.ts";

export interface RetentionLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface RetentionOptions {
  retentionDays: number;
  intervalMinutes: number;
  /**
   * A sweep that would delete more than this fraction of all rooms refuses to
   * run and logs instead. Set `confirmBulkDelete` to override.
   */
  bulkDeleteFraction: number;
  /** Fractions are meaningless on a handful of rooms, so small sweeps pass. */
  bulkDeleteMinimum: number;
  confirmBulkDelete: boolean;
}

/**
 * Deletes rooms whose last activity is older than the configured retention
 * period. This is a real `delete`, not a flag: after a sweep the room is gone
 * from the live database, and the only remaining copy is whatever backups the
 * operator keeps (see the retention section of the README).
 *
 * Because of that, a sweep large enough to look like a mistake stops itself.
 * The realistic failure here is not a bug but a typo: changing
 * DATA_RETENTION_DAYS from 3650 to 365 and restarting deletes nine years of
 * rooms within seconds of the process coming up, and nothing on this host
 * would notice. A guard costs one count query per sweep.
 */
export function startRetentionSweeper(
  store: RoomStore,
  logger: RetentionLogger,
  options: RetentionOptions,
): { stop: () => void; runOnce: () => Promise<number> } {
  const runOnce = async (): Promise<number> => {
    const { retentionDays, bulkDeleteFraction, bulkDeleteMinimum, confirmBulkDelete } = options;

    if (!confirmBulkDelete) {
      const { expiredRooms, totalRooms } = await store.countExpired(retentionDays);
      const overMinimum = expiredRooms >= bulkDeleteMinimum;
      const overFraction = totalRooms > 0 && expiredRooms / totalRooms > bulkDeleteFraction;
      if (overMinimum && overFraction) {
        logger.warn(
          {
            expiredRooms,
            totalRooms,
            retentionDays,
            bulkDeleteFraction,
            bulkDeleteMinimum,
          },
          "retention sweep skipped: it would delete an unusually large share of all rooms. " +
            "If DATA_RETENTION_DAYS is correct, set RETENTION_CONFIRM_BULK_DELETE=true to allow it.",
        );
        return 0;
      }
    }

    const { deletedRooms, codes } = await store.purgeExpired(retentionDays);
    if (deletedRooms > 0) {
      // Room codes, not student content. Without them a sweep is unauditable.
      logger.info({ deletedRooms, retentionDays, codes }, "retention sweep deleted expired rooms");
    }
    return deletedRooms;
  };

  const tick = () => {
    runOnce().catch((error: unknown) => {
      logger.error({ err: error }, "retention sweep failed");
    });
  };

  // Run once at startup so an operator who shortens the period sees it applied
  // without waiting a whole interval. The guard above is what makes running it
  // this eagerly safe.
  tick();
  const timer = setInterval(tick, options.intervalMinutes * 60_000);
  timer.unref();

  return { stop: () => clearInterval(timer), runOnce };
}
