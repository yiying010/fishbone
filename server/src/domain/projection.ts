/**
 * Projects an accepted room snapshot into the relational tables.
 *
 * The snapshot JSONB on `rooms` stays the source of truth; these tables are a
 * derived, queryable view of it (who submitted what, which grouping won, how
 * each voting round went, what was exported). Rebuilding them from the
 * snapshot on every accepted write means they can never disagree with it, and
 * means no merge logic is duplicated on the server.
 *
 * Runs inside the caller's transaction.
 */

import type { PoolClient } from "../db/pool.ts";
import {
  ITEM_KINDS,
  PROPOSAL_KINDS,
  VOTE_KINDS,
  readBoolean,
  readItems,
  readProposals,
  readRound,
  readSources,
  readString,
  readVotes,
  type Snapshot,
} from "./snapshot.ts";

/**
 * Postgres refuses an `on conflict do update` that would touch the same row
 * twice. The projection shares a transaction with the revision bump, so a
 * snapshot carrying one duplicated id would roll the write back, and the client
 * would retry the same payload forever: a permanent, per-room denial of
 * service, reachable by anyone who knows the room code. Collapsing duplicates
 * here, last occurrence winning, removes the whole class.
 */
function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

const KEY_SEPARATOR = String.fromCharCode(31);

export interface ProjectionContext {
  roomId: number;
  /** The member whose POST produced this snapshot, if any. */
  memberId: string | null;
  /** That member's own step counter; the room's step is the furthest any member has reached. */
  step: number | null;
}

export async function projectSnapshot(
  client: PoolClient,
  snapshot: Snapshot,
  context: ProjectionContext,
): Promise<void> {
  const { roomId } = context;

  await projectMembers(client, snapshot, context);
  await projectSubmissions(client, snapshot, roomId);
  await projectGroupings(client, snapshot, roomId);
  await projectVotes(client, snapshot, roomId);

  await client.query(
    `update rooms
        set current_step = coalesce((select max(current_step) from members where room_id = $1), 0)
      where id = $1`,
    [roomId],
  );
}

async function projectMembers(client: PoolClient, snapshot: Snapshot, context: ProjectionContext): Promise<void> {
  const sources = dedupe(readSources(snapshot), (source) => source.id);

  await client.query(
    `insert into members (room_id, member_id, display_name, color, is_system, has_joined)
     select $1, t.member_id, t.display_name, t.color, t.is_system, t.has_joined
       from unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::boolean[])
         as t(member_id, display_name, color, is_system, has_joined)
     on conflict (room_id, member_id) do update
       -- Never blank a stored name: a client that merged a partial source
       -- record can post an entry with no name, and that name is also what
       -- groupings.title is built from.
       set display_name = case when excluded.display_name = '' then members.display_name
                               else excluded.display_name end,
           color        = excluded.color,
           is_system    = excluded.is_system,
           -- a member who has joined never un-joins within a room
           has_joined   = members.has_joined or excluded.has_joined`,
    [
      context.roomId,
      sources.map((s) => s.id),
      sources.map((s) => s.name),
      sources.map((s) => s.color),
      sources.map((s) => s.system),
      sources.map((s) => s.joined),
    ],
  );

  // Members are never deleted here: the snapshot's source list is merged
  // client-side and a stale client can post a snapshot that has not yet seen a
  // newcomer. Dropping rows on that basis would lose attribution.

  if (context.memberId !== null) {
    await client.query(
      `update members
          set last_seen_at = now(),
              current_step = greatest(current_step, $3)
        where room_id = $1 and member_id = $2`,
      [context.roomId, context.memberId, context.step ?? 0],
    );
  }
}

async function projectSubmissions(client: PoolClient, snapshot: Snapshot, roomId: number): Promise<void> {
  const collected = ITEM_KINDS.flatMap(({ kind, field, step }) =>
    readItems(snapshot, field).map((item) => ({ kind, step, item })),
  );
  const rows = dedupe(collected, (row) => row.kind + KEY_SEPARATOR + row.item.id);

  const kinds = rows.map((row) => row.kind);
  const ids = rows.map((row) => row.item.id);
  const steps = rows.map((row) => row.step);
  const authors = rows.map((row) => row.item.author);
  const bodies = rows.map((row) => row.item.text);
  const statuses = rows.map((row) => row.item.status);
  const payloads = rows.map((row) => JSON.stringify(row.item.payload));

  await client.query(
    `insert into submissions (room_id, kind, item_id, step, author_member_id, body, status, payload)
     select $1, t.kind, t.item_id, t.step, t.author, t.body, t.status, t.payload::jsonb
       from unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[])
         as t(kind, item_id, step, author, body, status, payload)
     on conflict (room_id, kind, item_id) do update
       set step             = excluded.step,
           author_member_id = coalesce(excluded.author_member_id, submissions.author_member_id),
           body             = excluded.body,
           status           = excluded.status,
           payload          = excluded.payload,
           updated_at       = now()
       where submissions.body    is distinct from excluded.body
          or submissions.status  is distinct from excluded.status
          or submissions.payload is distinct from excluded.payload`,
    [roomId, kinds, ids, steps, authors, bodies, statuses, payloads],
  );

  await client.query(
    `delete from submissions s
      where s.room_id = $1
        and not exists (
          select 1 from unnest($2::text[], $3::text[]) as t(kind, item_id)
           where t.kind = s.kind and t.item_id = s.item_id)`,
    [roomId, kinds, ids],
  );
}

async function projectGroupings(client: PoolClient, snapshot: Snapshot, roomId: number): Promise<void> {
  const collected = PROPOSAL_KINDS.flatMap(({ kind, field, confirmedField }) => {
    const confirmed = readString(snapshot, confirmedField);
    return readProposals(snapshot, field).map((proposal) => ({
      kind,
      proposal,
      official: confirmed !== "" && confirmed === proposal.id,
    }));
  });
  const rows = dedupe(collected, (row) => row.kind + KEY_SEPARATOR + row.proposal.id);

  const kinds = rows.map((row) => row.kind);
  const ids = rows.map((row) => row.proposal.id);
  const authors = rows.map((row) => row.proposal.author);
  const officials = rows.map((row) => row.official);
  const groups = rows.map((row) => JSON.stringify(row.proposal.groups));
  const payloads = rows.map((row) => JSON.stringify(row.proposal.payload));

  // The proposal's title is rendered client-side from the author's display
  // name; store the same thing so exports do not need the client.
  await client.query(
    `insert into groupings (room_id, kind, proposal_id, author_member_id, title, is_official, payload)
     select $1, t.kind, t.proposal_id, t.author,
            coalesce((select m.display_name from members m
                       where m.room_id = $1 and m.member_id = t.author), ''),
            t.is_official,
            jsonb_build_object('groups', t.groups::jsonb) || t.payload::jsonb
       from unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[], $7::text[])
         as t(kind, proposal_id, author, is_official, groups, payload)
     on conflict (room_id, kind, proposal_id) do update
       set author_member_id = coalesce(excluded.author_member_id, groupings.author_member_id),
           title            = excluded.title,
           is_official      = excluded.is_official,
           payload          = excluded.payload,
           updated_at       = now()`,
    [roomId, kinds, ids, authors, officials, groups, payloads],
  );

  await client.query(
    `delete from groupings g
      where g.room_id = $1
        and not exists (
          select 1 from unnest($2::text[], $3::text[]) as t(kind, proposal_id)
           where t.kind = g.kind and t.proposal_id = g.proposal_id)`,
    [roomId, kinds, ids],
  );
}

async function projectVotes(client: PoolClient, snapshot: Snapshot, roomId: number): Promise<void> {
  const roundRows: { kind: string; round: number; tie: boolean; resolved: string }[] = [];
  const voteRows: { kind: string; round: number; memberId: string; value: string }[] = [];

  for (const { kind, field, roundField, resolvedField } of VOTE_KINDS) {
    const votes = readVotes(snapshot, field, roundField);
    const currentRound = readRound(snapshot, roundField);
    // `solutionTie` is the only tie flag the snapshot carries; every other
    // tie is derived in the UI from the counts, which are reproducible here.
    const tie = kind === "solution" ? readBoolean(snapshot, "solutionTie") : false;
    const resolved = resolvedField === null ? "" : readString(snapshot, resolvedField);

    for (const round of new Set<number>([currentRound, ...votes.map((vote) => vote.round)])) {
      roundRows.push({
        kind,
        round,
        tie: round === currentRound && tie,
        resolved: round === currentRound ? resolved : "",
      });
    }
    for (const vote of votes) {
      voteRows.push({ kind, round: vote.round, memberId: vote.memberId, value: vote.value });
    }
  }

  const rounds = dedupe(roundRows, (row) => row.kind + KEY_SEPARATOR + row.round);
  const cast = dedupe(voteRows, (row) => row.kind + KEY_SEPARATOR + row.round + KEY_SEPARATOR + row.memberId);

  const roundKinds = rounds.map((row) => row.kind);
  const roundNumbers = rounds.map((row) => row.round);
  const roundTies = rounds.map((row) => row.tie);
  const roundResolved = rounds.map((row) => row.resolved);

  const voteKinds = cast.map((row) => row.kind);
  const voteRounds = cast.map((row) => row.round);
  const voteMembers = cast.map((row) => row.memberId);
  const voteValues = cast.map((row) => row.value);

  await client.query(
    `insert into vote_rounds (room_id, kind, round, is_tie, resolved_value)
     select $1, t.kind, t.round, t.is_tie, t.resolved_value
       from unnest($2::text[], $3::int[], $4::boolean[], $5::text[])
         as t(kind, round, is_tie, resolved_value)
     on conflict (room_id, kind, round) do update
       set is_tie         = excluded.is_tie,
           resolved_value = excluded.resolved_value,
           updated_at     = now()
       where vote_rounds.is_tie         is distinct from excluded.is_tie
          or vote_rounds.resolved_value is distinct from excluded.resolved_value`,
    [roomId, roundKinds, roundNumbers, roundTies, roundResolved],
  );

  await client.query(
    `insert into votes (room_id, kind, round, member_id, value)
     select $1, t.kind, t.round, t.member_id, t.value
       from unnest($2::text[], $3::int[], $4::text[], $5::text[])
         as t(kind, round, member_id, value)
     on conflict (room_id, kind, round, member_id) do update
       set value   = excluded.value,
           cast_at = now()
       where votes.value is distinct from excluded.value`,
    [roomId, voteKinds, voteRounds, voteMembers, voteValues],
  );

  await client.query(
    `delete from votes v
      where v.room_id = $1
        and not exists (
          select 1 from unnest($2::text[], $3::int[], $4::text[]) as t(kind, round, member_id)
           where t.kind = v.kind and t.round = v.round and t.member_id = v.member_id)`,
    [roomId, voteKinds, voteRounds, voteMembers],
  );

  // Past rounds are kept deliberately: how a tie was broken is part of the
  // record. Only rounds the snapshot no longer mentions at all are dropped.
  await client.query(
    `delete from vote_rounds r
      where r.room_id = $1
        and not exists (
          select 1 from unnest($2::text[], $3::int[]) as t(kind, round)
           where t.kind = r.kind and t.round = r.round)`,
    [roomId, roundKinds, roundNumbers],
  );
}
