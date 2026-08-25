import type { Pool } from "../db/pool.ts";

/** Data access used exclusively by authenticated administrative endpoints. */
export class AdminRoomRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async exportRoom(code: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query<{ id: number } & Record<string, unknown>>(
      `select id, code, revision, current_step, created_at, updated_at, last_activity_at, snapshot
         from rooms where lower(code) = lower($1)`,
      [code],
    );
    const room = rows[0];
    if (room === undefined) return null;

    const [members, submissions, groupings, voteRounds, votes, artifacts] = await Promise.all([
      this.pool.query(`select * from members where room_id = $1 order by first_seen_at`, [room.id]),
      this.pool.query(`select * from submissions where room_id = $1 order by kind, created_at`, [room.id]),
      this.pool.query(`select * from groupings where room_id = $1 order by kind, created_at`, [room.id]),
      this.pool.query(`select * from vote_rounds where room_id = $1 order by kind, round`, [room.id]),
      this.pool.query(`select * from votes where room_id = $1 order by kind, round, member_id`, [room.id]),
      this.pool.query(
        `select id, revision, format, filename, exported_by, exported_at, length(content) as content_bytes, content
           from artifacts where room_id = $1 order by exported_at`,
        [room.id],
      ),
    ]);

    return {
      room,
      members: members.rows,
      submissions: submissions.rows,
      groupings: groupings.rows,
      voteRounds: voteRounds.rows,
      votes: votes.rows,
      artifacts: artifacts.rows,
    };
  }

  async deleteRoom(code: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`delete from rooms where lower(code) = lower($1)`, [code]);
    return (rowCount ?? 0) > 0;
  }
}
