import type { Pool } from "../db/pool.ts";

/** Contains only the read and destructive queries used by retention sweeps. */
export class RetentionRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async countExpired(retentionDays: number): Promise<{ expiredRooms: number; totalRooms: number }> {
    const { rows } = await this.pool.query<{ expired: string; total: string }>(
      `select count(*) filter (where last_activity_at < now() - make_interval(days => $1::int)) as expired,
              count(*) as total
       from rooms`,
      [retentionDays],
    );
    const row = rows[0];
    return { expiredRooms: Number(row?.expired ?? 0), totalRooms: Number(row?.total ?? 0) };
  }

  /** Hard-deletes expired rooms and returns their non-content identifiers for the audit log. */
  async purgeExpired(retentionDays: number): Promise<{ deletedRooms: number; codes: string[] }> {
    const { rows } = await this.pool.query<{ code: string }>(
      `delete from rooms
       where last_activity_at < now() - make_interval(days => $1::int)
       returning code`,
      [retentionDays],
    );
    return { deletedRooms: rows.length, codes: rows.map((row) => row.code) };
  }
}
