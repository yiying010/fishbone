import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { projectSnapshot } from "../domain/projection.ts";
import type { Snapshot } from "../domain/snapshot.ts";
import { withTransaction, type Pool, type PoolClient } from "../db/pool.ts";
import { AdminRoomRepository } from "./admin-repository.ts";
import { ArtifactRepository, type ArtifactInput } from "./artifact-repository.ts";
import { generateRoomCode } from "./codes.ts";
import { MemberIdentityError, RoomCapacityError, RoomNotFoundError } from "./errors.ts";
import { RetentionRepository } from "./retention-repository.ts";
import { buildAuthoritativeSnapshot } from "./authoritative-snapshot.ts";

export {
  MemberIdentityError,
  RoomCapacityError,
  RoomCodeError,
  RoomNotFoundError,
} from "./errors.ts";
export { normalizeMemberId } from "./member-id.ts";

export interface RoomState {
  revision: number;
  snapshot: Snapshot;
  currentStep: number;
  expectedMemberCount: number | null;
  membersLocked: boolean;
  members: RoomMember[];
}

export interface RoomMember {
  memberId: string;
  displayName: string;
  currentStep: number;
}

export interface WriteAccepted {
  status: "accepted";
  revision: number;
  currentStep: number;
}

export interface WriteConflict {
  status: "conflict";
  revision: number;
  snapshot: Snapshot;
  currentStep: number;
  expectedMemberCount: number | null;
  membersLocked: boolean;
  members: RoomMember[];
}

export type WriteResult = WriteAccepted | WriteConflict;

interface RoomRow {
  id: number;
  revision: number;
  snapshot: Snapshot;
  current_step: number;
  expected_member_count: number | null;
  members_locked: boolean;
}

export interface JoinResult extends RoomState {
  /** Returned once, at join. Only its digest is stored. */
  token: string;
}

export interface AuthenticatedMember {
  memberId: string;
  roomId: number;
}

/**
 * Sessions are stored as a digest so that a leaked database dump does not hand
 * over live sessions as well as the rooms they open.
 */
function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

const MEMBER_COLORS = ["#276EF1", "#00A676", "#D95D39", "#7B61FF", "#B7791F", "#008C95"] as const;

const DURABLE_REVISION_FIELDS = [
  "revisionMode",
  "revisionTarget",
  "revisionReturnChain",
  "revisionChainIndex",
  "revisionFromStep",
  "revisionRoundId",
  "revisionCompletedRound",
  "revisionTransitionVersion",
  "revisionCheckpointGenerations",
  "revisionCheckpointConfirmations",
] as const;

/** Older clients may omit revision-chain fields; omission must not erase them. */
function preserveDurableRevisionFields(previous: Snapshot, submitted: Snapshot): Snapshot {
  const merged: Snapshot = { ...submitted };
  for (const field of DURABLE_REVISION_FIELDS) {
    if (!(field in merged) && field in previous) merged[field] = previous[field];
  }
  return merged;
}

export class RoomStore {
  // Written out rather than as a parameter property: Node's strip-only
  // TypeScript support cannot erase those, and `npm run dev` / `npm run migrate`
  // execute these sources directly.
  private readonly pool: Pool;
  private readonly artifacts: ArtifactRepository;
  private readonly retention: RetentionRepository;
  private readonly administration: AdminRoomRepository;

  constructor(pool: Pool) {
    this.pool = pool;
    this.artifacts = new ArtifactRepository(pool);
    this.retention = new RetentionRepository(pool);
    this.administration = new AdminRoomRepository(pool);
  }

  /**
   * Creates a room under a fresh server-generated code.
   *
   * Rooms are only ever created here. Joining does not create one, so a POST to
   * a guessed code cannot bring a room into existence, and every code that
   * exists came from a CSPRNG rather than from someone naming their class.
   */
  async createRoom(
    codeLength: number,
    expectedMemberCount: number | null,
  ): Promise<{ code: string; expectedMemberCount: number | null; membersLocked: boolean }> {
    // A collision at 50 bits is not a thing that happens, but the unique index
    // is the authority, not that assumption.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateRoomCode(codeLength);
      const { rowCount } = await this.pool.query(
        `insert into rooms (code, expected_member_count)
         values ($1, $2)
         on conflict (lower(code)) do nothing`,
        [code, expectedMemberCount],
      );
      if ((rowCount ?? 0) > 0) return { code, expectedMemberCount, membersLocked: false };
    }
    throw new Error("could not allocate an unused room code");
  }

  /**
   * Joins an existing room and issues this member a session token. Returns null
   * when there is no such room; the caller answers that indistinguishably from
   * a bad token.
   */
  async join(
    code: string,
    memberId: string,
    displayName: string,
    step: number,
    sessionTtlHours: number,
    previousToken: string,
  ): Promise<JoinResult | null> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<RoomRow>(
        `update rooms set last_activity_at = now()
          where lower(code) = lower($1)
          returning id, revision, snapshot, current_step, expected_member_count, members_locked`,
        [code],
      );
      const room = rows[0];
      if (room === undefined) return null;

      const existing = await client.query<{ session_token_hash: Buffer | null }>(
        `select session_token_hash
           from members
          where room_id = $1 and member_id = $2
          for update`,
        [room.id, memberId],
      );
      const existingHash = existing.rows[0]?.session_token_hash;
      let newMemberOrdinal = 0;
      if (existingHash !== undefined) {
        const candidate = hashToken(previousToken);
        if (previousToken === "" || existingHash === null || !timingSafeEqual(existingHash, candidate)) {
          throw new MemberIdentityError("member id is already owned by another session");
        }
      }

      if (existingHash === undefined) {
        if (room.members_locked) throw new RoomCapacityError("room membership is locked");
        if (room.expected_member_count !== null) {
          const count = await client.query<{ count: string }>(
            `select count(*)::text as count
               from members
              where room_id = $1 and not is_system`,
            [room.id],
          );
          newMemberOrdinal = Number(count.rows[0]?.count ?? 0);
          if (newMemberOrdinal >= room.expected_member_count) {
            throw new RoomCapacityError("room is full");
          }
        } else {
          const count = await client.query<{ count: string }>(
            `select count(*)::text as count
               from members
              where room_id = $1 and not is_system`,
            [room.id],
          );
          newMemberOrdinal = Number(count.rows[0]?.count ?? 0);
        }
      }

      const token = randomBytes(32).toString("base64url");
      await client.query(
        `insert into members (room_id, member_id, display_name, color, has_joined, current_step,
                              session_token_hash, session_expires_at)
         values ($1, $2, $3, $7, true, $4, $5, now() + make_interval(hours => $6::int))
         on conflict (room_id, member_id) do update
           set display_name = case when excluded.display_name = '' then members.display_name
                                   else excluded.display_name end,
               has_joined         = true,
               current_step       = greatest(members.current_step, excluded.current_step),
               last_seen_at       = now(),
               session_token_hash = excluded.session_token_hash,
               session_expires_at = excluded.session_expires_at`,
        [
          room.id,
          memberId,
          displayName,
          step,
          hashToken(token),
          sessionTtlHours,
          MEMBER_COLORS[newMemberOrdinal % MEMBER_COLORS.length],
        ],
      );

      if (room.expected_member_count !== null) {
        const count = await client.query<{ count: string }>(
          `select count(*)::text as count
             from members
            where room_id = $1 and not is_system`,
          [room.id],
        );
        if (Number(count.rows[0]?.count ?? 0) >= room.expected_member_count) {
          await client.query(`update rooms set members_locked = true where id = $1`, [room.id]);
          room.members_locked = true;
        }
      }

      const state = await this.roomState(client, room);
      return {
        token,
        ...state,
        currentStep: state.members.find((member) => member.memberId === memberId)?.currentStep ?? state.currentStep,
      };
    });
  }

  /**
   * Resolves a bearer token to the member who holds it, within one room.
   *
   * Also slides the expiry and marks the member as seen, so a lesson that runs
   * longer than the session lifetime does not log a class out mid-activity, and
   * so a member who only reads still shows as present.
   */
  async authenticate(code: string, token: string, sessionTtlHours: number): Promise<AuthenticatedMember | null> {
    if (token === "") return null;
    const { rows } = await this.pool.query<{ member_id: string; room_id: number }>(
      `update members m
          set session_expires_at = now() + make_interval(hours => $3::int),
              last_seen_at       = now()
         from rooms r
        where r.id = m.room_id
          and lower(r.code) = lower($1)
          and m.session_token_hash = $2
          and m.session_expires_at > now()
        returning m.member_id, m.room_id`,
      [code, hashToken(token), sessionTtlHours],
    );
    const member = rows[0];
    return member === undefined ? null : { memberId: member.member_id, roomId: member.room_id };
  }

  async read(code: string): Promise<RoomState | null> {
    const { rows } = await this.pool.query<RoomRow>(
      `select id, revision, snapshot, current_step, expected_member_count, members_locked
         from rooms where lower(code) = lower($1)`,
      [code],
    );
    const room = rows[0];
    return room === undefined ? null : this.roomState(this.pool, room);
  }

  private async roomState(db: Pool | PoolClient, room: RoomRow): Promise<RoomState> {
    return {
      revision: room.revision,
      snapshot: await buildAuthoritativeSnapshot(db, room.id, room.snapshot),
      currentStep: room.current_step,
      expectedMemberCount: room.expected_member_count,
      membersLocked: room.members_locked,
      members: await this.membersForRoom(db, room.id),
    };
  }

  private async membersForRoom(db: Pool | PoolClient, roomId: number): Promise<RoomMember[]> {
    const { rows } = await db.query<{ member_id: string; display_name: string; current_step: number }>(
      `select member_id, display_name, current_step
         from members
        where room_id = $1 and not is_system
        order by first_seen_at, member_id`,
      [roomId],
    );
    return rows.map((member) => ({
      memberId: member.member_id,
      displayName: member.display_name,
      currentStep: member.current_step,
    }));
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

  /**
   * Cheap revision probe: just the integer, not the full snapshot. Used by the
   * long-poll hold loop and by the AI review route's post-provider-call
   * staleness check.
   */
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
        `select id, revision, snapshot, current_step, expected_member_count, members_locked from rooms
          where lower(code) = lower($1) for update`,
        [code],
      );
      const room = rows[0];
      if (room === undefined) {
        throw new RoomNotFoundError("no such room");
      }

      if (room.revision !== baseRevision) {
        const members = await this.membersForRoom(client, room.id);
        return {
          status: "conflict",
          revision: room.revision,
          snapshot: await buildAuthoritativeSnapshot(client, room.id, room.snapshot),
          currentStep: members.find((member) => member.memberId === memberId)?.currentStep ?? room.current_step,
          expectedMemberCount: room.expected_member_count,
          membersLocked: room.members_locked,
          members,
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
        [room.id, JSON.stringify(preserveDurableRevisionFields(room.snapshot ?? {}, snapshot))],
      );
      const revision = updated[0]?.revision;
      if (revision === undefined) throw new Error("room update returned no row");

      await projectSnapshot(client, snapshot, { roomId: room.id, memberId, step });

      const { rows: progressRows } = await client.query<{ current_step: number }>(
        `select coalesce(
                  (select current_step from members where room_id = $1 and member_id = $2),
                  (select current_step from rooms where id = $1)
                ) as current_step`,
        [room.id, memberId],
      );
      const currentStep = progressRows[0]?.current_step;
      if (currentStep === undefined) throw new Error("room progress disappeared during write");

      return { status: "accepted", revision, currentStep };
    });
  }

  async saveArtifact(
    code: string,
    input: ArtifactInput,
  ): Promise<{ id: number; revision: number }> {
    return this.artifacts.save(code, input);
  }

  async countExpired(retentionDays: number): Promise<{ expiredRooms: number; totalRooms: number }> {
    return this.retention.countExpired(retentionDays);
  }

  async purgeExpired(retentionDays: number): Promise<{ deletedRooms: number; codes: string[] }> {
    return this.retention.purgeExpired(retentionDays);
  }

  async exportRoom(code: string): Promise<Record<string, unknown> | null> {
    return this.administration.exportRoom(code);
  }

  async deleteRoom(code: string): Promise<boolean> {
    return this.administration.deleteRoom(code);
  }
}
