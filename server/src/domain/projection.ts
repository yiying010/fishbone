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

import type { PoolClient } from "../db/pool.js";
import {
  ITEM_KINDS,
  PROPOSAL_KINDS,
  VOTE_KINDS,
  readBoolean,
  readItems,
  readProposals,
  readSources,
  readString,
  readVotes,
  type Snapshot,
} from "./snapshot.js";

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
  const sources = readSources(snapshot);

  await client.query(
    `insert into members (room_id, member_id, display_name, color, is_system, has_joined)
     select $1, t.member_id, t.display_name, t.color, t.is_system, t.has_joined
       from unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::boolean[])
         as t(member_id, display_name, color, is_system, has_joined)
     on conflict (room_id, member_id) do update
       set display_name = excluded.display_name,
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
  const kinds: string[] = [];
  const ids: string[] = [];
  const steps: number[] = [];
  const authors: (string | null)[] = [];
  const bodies: string[] = [];
  const statuses: string[] = [];
  const payloads: string[] = [];

  for (const { kind, field, step } of ITEM_KINDS) {
    for (const item of readItems(snapshot, field)) {
      kinds.push(kind);
      ids.push(item.id);
      steps.push(step);
      authors.push(item.author);
      bodies.push(item.text);
      statuses.push(item.status);
      payloads.push(JSON.stringify(item.payload));
    }
  }

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
  const kinds: string[] = [];
  const ids: string[] = [];
  const authors: (string | null)[] = [];
  const officials: boolean[] = [];
  const groups: string[] = [];
  const payloads: string[] = [];

  for (const { kind, field, confirmedField } of PROPOSAL_KINDS) {
    const confirmed = readString(snapshot, confirmedField);
    for (const proposal of readProposals(snapshot, field)) {
      kinds.push(kind);
      ids.push(proposal.id);
      authors.push(proposal.author);
      officials.push(confirmed !== "" && confirmed === proposal.id);
      groups.push(JSON.stringify(proposal.groups));
      payloads.push(JSON.stringify(proposal.payload));
    }
  }

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
  const roundKinds: string[] = [];
  const roundNumbers: number[] = [];
  const roundTies: boolean[] = [];
  const roundResolved: string[] = [];

  const voteKinds: string[] = [];
  const voteRounds: number[] = [];
  const voteMembers: string[] = [];
  const voteValues: string[] = [];

  for (const { kind, field, roundField, resolvedField } of VOTE_KINDS) {
    const votes = readVotes(snapshot, field, roundField);
    const currentRound = roundField === null ? 1 : Math.max(1, Math.trunc(Number(snapshot[roundField]) || 1));
    // `solutionTie` is the only tie flag the snapshot carries; every other
    // tie is derived in the UI from the counts, which are reproducible here.
    const tie = kind === "solution" ? readBoolean(snapshot, "solutionTie") : false;
    const resolved = resolvedField === null ? "" : readString(snapshot, resolvedField);

    const rounds = new Set<number>([currentRound, ...votes.map((vote) => vote.round)]);
    for (const round of rounds) {
      roundKinds.push(kind);
      roundNumbers.push(round);
      roundTies.push(round === currentRound && tie);
      roundResolved.push(round === currentRound ? resolved : "");
    }
    for (const vote of votes) {
      voteKinds.push(kind);
      voteRounds.push(vote.round);
      voteMembers.push(vote.memberId);
      voteValues.push(vote.value);
    }
  }

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
