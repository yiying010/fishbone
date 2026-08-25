import { projectSnapshot } from "../domain/projection.ts";
import type { Snapshot } from "../domain/snapshot.ts";
import { withTransaction, type Pool } from "../db/pool.ts";

export interface RoomState {
  revision: number;
  snapshot: Snapshot;
  currentStep: number;
}

export interface WriteAccepted {
  status: "accepted";
  revision: number;
}

export interface WriteConflict {
  status: "conflict";
  revision: number;
  snapshot: Snapshot;
  currentStep: number;
}

export type WriteResult = WriteAccepted | WriteConflict;

export class RoomCodeError extends Error {}

/**
 * The room code is well formed but no such room exists. Distinct from
 * RoomCodeError because the client has to react differently: a malformed code
 * is worth reporting to the student, a missing room means the room was deleted
 * or has passed its retention period and this client must stop syncing.
 */
export class RoomNotFoundError extends Error {}

/**
 * Room codes are typed by students on a phone. Normalising whitespace and
 * matching case-insensitively is the difference between a group finding each
 * other and silently sitting in two different rooms.
 */
export function normalizeRoomCode(input: unknown, maxLength: number): string {
  if (typeof input !== "string") throw new RoomCodeError("room code must be a string");
  const code = input.trim().replace(/\s+/g, " ");
  if (code === "") throw new RoomCodeError("room code must not be empty");
  if (code.length > maxLength) throw new RoomCodeError(`room code must be at most ${maxLength} characters`);
  if (Array.from(code).some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7f)) {
    throw new RoomCodeError("room code must not contain control characters");
  }
  // The code travels as one URL path segment. A slash or percent survives
  // encodeURIComponent but not the proxy in front of this service, which would
  // turn a typo into an unexplained 404 instead of a message a student can act
  // on. Verified against nginx, not assumed.
  if (/[\\/%?#]/.test(code)) {
    throw new RoomCodeError("room code must not contain / \\ % ? or #");
  }
  return code;
}

export function normalizeMemberId(input: unknown): string {
  if (typeof input !== "string") throw new RoomCodeError("memberId must be a string");
  const id = input.trim();
  if (id === "") throw new RoomCodeError("memberId must not be empty");
  if (id.length > 128) throw new RoomCodeError("memberId must be at most 128 characters");
  return id;
}

interface RoomRow {
  id: number;
  revision: number;
  snapshot: Snapshot;
  current_step: number;
}

export class RoomStore {
  // Written out rather than as a parameter property: Node's strip-only
  // TypeScript support cannot erase those, and `npm run dev` / `npm run migrate`
  // execute these sources directly.
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Creates the room if the code has never been used, and makes sure the
   * caller has a member row. Returns whatever state already exists so the
   * client can merge it into its own.
   */
  async join(code: string, memberId: string, displayName: string, step: number): Promise<RoomState> {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `insert into rooms (code) values ($1) on conflict (lower(code)) do nothing`,
        [code],
      );
      const { rows } = await client.query<RoomRow>(
        `update rooms set last_activity_at = now()
          where lower(code) = lower($1)
          returning id, revision, snapshot, current_step`,
        [code],
      );
      const room = rows[0];
      if (room === undefined) throw new Error(`room ${code} vanished between insert and update`);

      await client.query(
        `insert into members (room_id, member_id, display_name, has_joined, current_step)
         values ($1, $2, $3, true, $4)
         on conflict (room_id, member_id) do update
           set display_name = case when excluded.display_name = '' then members.display_name
                                   else excluded.display_name end,
               has_joined   = true,
               current_step = greatest(members.current_step, excluded.current_step),
               last_seen_at = now()`,
        [room.id, memberId, displayName, step],
      );

      return { revision: room.revision, snapshot: room.snapshot ?? {}, currentStep: room.current_step };
    });
  }

  async read(code: string): Promise<RoomState | null> {
    const { rows } = await this.pool.query<RoomRow>(
      `select id, revision, snapshot, current_step from rooms where lower(code) = lower($1)`,
      [code],
    );
    const room = rows[0];
    return room === undefined
      ? null
      : { revision: room.revision, snapshot: room.snapshot ?? {}, currentStep: room.current_step };
  }

  /**
   * Records that a member is still here and how far they have got. Called from
   * the sync poll, because a member who is only reading never writes, and
   * without this their last_seen_at would freeze at the moment they joined.
   */
  async touchMember(code: string, memberId: string, step: number): Promise<void> {
    await this.pool.query(
      `with m as (
         update members set last_seen_at = now(),
                            current_step = greatest(current_step, $3)
          where room_id = (select id from rooms where lower(code) = lower($1))
            and member_id = $2
          returning room_id, current_step)
       update rooms set current_step = (select current_step from m)
        where id = (select room_id from m)
          and rooms.current_step < (select current_step from m)`,
      [code, memberId, step],
    );
  }

  /** Cheap revision probe used by the long-poll hold loop. */
  async readRevision(code: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ revision: number }>(
      `select revision from rooms where lower(code) = lower($1)`,
      [code],
    );
    return rows[0]?.revision ?? null;
  }

  /**
   * Compare-and-set on the room revision. The client merged `baseRevision`
   * before producing this snapshot, so a mismatch means it has not seen
   * somebody else's work yet and must merge again, which is why the conflict
   * result carries the current snapshot.
   */
  async write(
    code: string,
    memberId: string | null,
    step: number | null,
    baseRevision: number,
    snapshot: Snapshot,
  ): Promise<WriteResult> {
    return withTransaction(this.pool, async (client) => {
      // Row lock: serialises concurrent writers to the same room so the
      // compare-and-set below cannot be read-modify-written out from under us.
      const { rows } = await client.query<RoomRow>(
        `select id, revision, snapshot, current_step from rooms
          where lower(code) = lower($1) for update`,
        [code],
      );
      const room = rows[0];
      if (room === undefined) {
        throw new RoomNotFoundError(`room ${code} does not exist; join it first`);
      }

      if (room.revision !== baseRevision) {
        return {
          status: "conflict",
          revision: room.revision,
          snapshot: room.snapshot ?? {},
          currentStep: room.current_step,
        };
      }

      const { rows: updated } = await client.query<{ revision: number }>(
        `update rooms
            set snapshot         = $2::jsonb,
                revision         = revision + 1,
                updated_at       = now(),
                last_activity_at = now()
          where id = $1
          returning revision`,
        [room.id, JSON.stringify(snapshot)],
      );
      const revision = updated[0]?.revision;
      if (revision === undefined) throw new Error("room update returned no row");

      await projectSnapshot(client, snapshot, { roomId: room.id, memberId, step });

      return { status: "accepted", revision };
    });
  }

  async saveArtifact(
    code: string,
    input: { format: string; filename: string; content: string; exportedBy: string | null },
  ): Promise<{ id: number; revision: number }> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ id: number; revision: number }>(
        `update rooms set last_activity_at = now()
          where lower(code) = lower($1)
          returning id, revision`,
        [code],
      );
      const room = rows[0];
      if (room === undefined) throw new RoomNotFoundError(`room ${code} does not exist; join it first`);

      const { rows: inserted } = await client.query<{ id: number }>(
        `insert into artifacts (room_id, revision, format, filename, content, exported_by)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [room.id, room.revision, input.format, input.filename, input.content, input.exportedBy],
      );
      const id = inserted[0]?.id;
      if (id === undefined) throw new Error("artifact insert returned no row");
      return { id, revision: room.revision };
    });
  }

  /** How many rooms a sweep would delete, without deleting anything. */
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

  /**
   * Hard delete. Rows go, cascades take the rest; nothing is tombstoned, so a
   * purged room is genuinely gone from the live database.
   *
   * Returns the codes it removed. A room code is not student content, and
   * without it a sweep leaves no way to answer "what did we just delete?" —
   * which matters because there is no undo.
   */
  async purgeExpired(retentionDays: number): Promise<{ deletedRooms: number; codes: string[] }> {
    const { rows } = await this.pool.query<{ code: string }>(
      `delete from rooms
       where last_activity_at < now() - make_interval(days => $1::int)
       returning code`,
      [retentionDays],
    );
    return { deletedRooms: rows.length, codes: rows.map((row) => row.code) };
  }

  /**
   * The relational projection for one room, as a single JSON document. This is
   * the shape a teacher or researcher wants: the snapshot alone is a merge
   * artefact, not a readable record.
   */
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
