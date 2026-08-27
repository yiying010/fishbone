import type { PoolClient } from "../../db/pool.ts";
import {
  VOTE_KINDS,
  monotonicVersion,
  readBoolean,
  readRound,
  readString,
  readVotes,
  type Snapshot,
} from "../snapshot.ts";
import { dedupe, KEY_SEPARATOR } from "./shared.ts";

export async function projectVotes(client: PoolClient, snapshot: Snapshot, roomId: number): Promise<void> {
  const roundRows: { kind: string; round: number; tie: boolean; resolved: string; contentVersion: number }[] = [];
  const voteRows: { kind: string; round: number; memberId: string; value: string; contentVersion: number }[] = [];

  for (const { kind, field, roundField, resolvedField } of VOTE_KINDS) {
    const votes = readVotes(snapshot, field, roundField);
    const currentRound = readRound(snapshot, roundField);
    // `solutionTie` is the only tie flag the snapshot carries; every other
    // tie is derived in the UI from the counts, which are reproducible here.
    const tie = kind === "solution" ? readBoolean(snapshot, "solutionTie") : false;
    const resolved = resolvedField === null ? "" : readString(snapshot, resolvedField);
    const kindVersion = monotonicVersion(snapshot[VOTE_VERSION_FIELDS[kind] ?? ""]);

    for (const round of new Set<number>([currentRound, ...votes.map((vote) => vote.round)])) {
      roundRows.push({
        kind,
        round,
        tie: round === currentRound && tie,
        resolved: round === currentRound ? resolved : "",
        contentVersion: Math.max(
          kindVersion,
          ...votes.filter((vote) => vote.round === round).map((vote) => vote.contentVersion),
        ),
      });
    }
    for (const vote of votes) {
      voteRows.push({
        kind,
        round: vote.round,
        memberId: vote.memberId,
        value: vote.value,
        contentVersion: Math.max(kindVersion, vote.contentVersion),
      });
    }
  }

  const rounds = dedupe(roundRows, (row) => row.kind + KEY_SEPARATOR + row.round);
  const cast = dedupe(voteRows, (row) => row.kind + KEY_SEPARATOR + row.round + KEY_SEPARATOR + row.memberId);
  const roundKinds = rounds.map((row) => row.kind);
  const roundNumbers = rounds.map((row) => row.round);
  const roundTies = rounds.map((row) => row.tie);
  const roundResolved = rounds.map((row) => row.resolved);
  const roundVersions = rounds.map((row) => row.contentVersion);
  const voteKinds = cast.map((row) => row.kind);
  const voteRounds = cast.map((row) => row.round);
  const voteMembers = cast.map((row) => row.memberId);
  const voteValues = cast.map((row) => row.value);
  const voteVersions = cast.map((row) => row.contentVersion);

  await client.query(
    `insert into vote_rounds (room_id, kind, round, is_tie, resolved_value, content_version)
     select $1, t.kind, t.round, t.is_tie, t.resolved_value, t.content_version
       from unnest($2::text[], $3::int[], $4::boolean[], $5::text[], $6::bigint[])
         as t(kind, round, is_tie, resolved_value, content_version)
     on conflict (room_id, kind, round) do update
       set is_tie         = excluded.is_tie,
           resolved_value = excluded.resolved_value,
           content_version = excluded.content_version,
           updated_at     = now()
       where excluded.content_version > vote_rounds.content_version`,
    [roomId, roundKinds, roundNumbers, roundTies, roundResolved, roundVersions],
  );

  await client.query(
    `insert into votes (room_id, kind, round, member_id, value, content_version)
     select $1, t.kind, t.round, t.member_id, t.value, t.content_version
       from unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::bigint[])
         as t(kind, round, member_id, value, content_version)
     on conflict (room_id, kind, round, member_id) do update
       set value           = excluded.value,
           content_version = excluded.content_version,
           cast_at         = now()
       where excluded.content_version > votes.content_version`,
    [roomId, voteKinds, voteRounds, voteMembers, voteValues, voteVersions],
  );
}

const VOTE_VERSION_FIELDS: Record<string, string> = {
  grouping: "groupingVersion",
  groupConfirm: "groupingVersion",
  problem: "problemVoteVersion",
  problemDraft: "problemDraftVersion",
  causeClass: "causeClassVersion",
  right: "rightVoteVersion",
  goalDraft: "goalDraftVersion",
  methodClass: "methodClassVersion",
  outcome: "outcomeVoteVersion",
  outcomeRevision: "outcomeRevisionVersion",
  solution: "solutionVoteVersion",
};
