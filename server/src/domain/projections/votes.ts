import type { PoolClient } from "../../db/pool.ts";
import {
  VOTE_KINDS,
  readBoolean,
  readRound,
  readString,
  readVotes,
  type Snapshot,
} from "../snapshot.ts";
import { dedupe, KEY_SEPARATOR } from "./shared.ts";

export async function projectVotes(client: PoolClient, snapshot: Snapshot, roomId: number): Promise<void> {
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

  // Past rounds remain part of the audit record unless the snapshot no longer
  // mentions them at all.
  await client.query(
    `delete from vote_rounds r
      where r.room_id = $1
        and not exists (
          select 1 from unnest($2::text[], $3::int[]) as t(kind, round)
           where t.kind = r.kind and t.round = r.round)`,
    [roomId, roundKinds, roundNumbers],
  );
}
