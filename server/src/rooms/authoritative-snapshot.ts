/**
 * Rebuilds projected room fields from PostgreSQL for hydrate and CAS conflict
 * replies. `rooms.snapshot` remains the compatibility base for fields that do
 * not yet have a relational projection.
 */

import type { Pool, PoolClient } from "../db/pool.ts";
import { ITEM_KINDS, VOTE_KINDS, clampRound, type Snapshot } from "../domain/snapshot.ts";

type Queryable = Pool | PoolClient;

interface SubmissionRow {
  kind: string;
  item_id: string;
  author_member_id: string | null;
  body: string;
  status: string;
  payload: unknown;
  content_version: number;
  deleted_version: number;
  deleted_at: string | null;
}

interface VoteRow {
  kind: string;
  round: number;
  member_id: string;
  value: string;
  content_version: number;
}

interface VoteRoundRow {
  kind: string;
  round: number;
  is_tie: boolean;
  resolved_value: string;
  content_version: number;
}

interface MemberRow {
  member_id: string;
  display_name: string;
  color: string;
  is_system: boolean;
  has_joined: boolean;
  is_active: boolean;
}

const MEMBER_COLORS = ["#276EF1", "#00A676", "#D95D39", "#7B61FF", "#B7791F", "#008C95"] as const;
const SAFE_COLOR = /^#[0-9A-Fa-f]{6}$/;

const DELETED_FIELDS: Record<string, string> = {
  distress: "deletedDistressIds",
  problem_detail: "deletedProblemDetailIds",
  cause: "deletedCauseIds",
  goal_idea: "deletedGoalIdeaIds",
  method: "deletedMethodIds",
};

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

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function maximum(values: number[]): number {
  return values.reduce((highest, value) => Math.max(highest, Number.isFinite(value) ? value : 0), 0);
}

function live(row: { content_version: number; deleted_version: number; deleted_at: string | null }): boolean {
  return row.deleted_at === null && row.content_version >= row.deleted_version;
}

function itemFrom(row: SubmissionRow): Record<string, unknown> {
  const item: Record<string, unknown> = {
    ...record(row.payload),
    id: row.item_id,
    text: row.body,
    status: row.status,
    contentVersion: row.content_version,
  };
  if (row.author_member_id !== null) {
    item["createdBy"] = row.author_member_id;
    item["source"] = row.author_member_id;
  }
  return item;
}

function tombstoneFrom(row: SubmissionRow): Record<string, unknown> {
  const item = itemFrom(row);
  item["text"] = "";
  item["contentVersion"] = row.deleted_version;
  item["deletedAt"] = item["deletedAt"] ?? row.deleted_at ?? true;
  return item;
}

export async function buildAuthoritativeSnapshot(
  db: Queryable,
  roomId: number,
  rawSnapshot: Snapshot | null | undefined,
): Promise<Snapshot> {
  const snapshot: Snapshot = { ...(rawSnapshot ?? {}) };
  const [submissions, votes, voteRounds, members] = await Promise.all([
    db.query<SubmissionRow>(
      `select kind, item_id, author_member_id, body, status, payload,
              content_version, deleted_version, deleted_at
         from submissions
        where room_id = $1
        order by kind, item_id`,
      [roomId],
    ),
    db.query<VoteRow>(
      `select kind, round, member_id, value, content_version
         from votes
        where room_id = $1
        order by kind, round, member_id`,
      [roomId],
    ),
    db.query<VoteRoundRow>(
      `select kind, round, is_tie, resolved_value, content_version
         from vote_rounds
        where room_id = $1
        order by kind, round`,
      [roomId],
    ),
    db.query<MemberRow>(
      `select member_id, display_name, color, is_system, has_joined, is_active
         from members
        where room_id = $1
        order by first_seen_at, member_id`,
      [roomId],
    ),
  ]);

  for (const { kind, field } of ITEM_KINDS) {
    const rows = submissions.rows.filter((row) => row.kind === kind);
    snapshot[field] = kind === "reflection"
      ? rows.map((row) => live(row) ? itemFrom(row) : tombstoneFrom(row))
      : rows.filter(live).map(itemFrom);
    snapshot[`${field}Version`] = maximum(
      rows.map((row) => Math.max(row.content_version, row.deleted_version)),
    );

    const deletedField = DELETED_FIELDS[kind];
    if (deletedField !== undefined) {
      snapshot[deletedField] = rows
        .filter((row) => row.deleted_at !== null && row.deleted_version > row.content_version)
        .map((row) => row.item_id);
    }
  }

  // Never hydrate participant identity from stale browser JSON.
  snapshot["sources"] = members.rows.map((member, index) => ({
    id: member.member_id,
    name: member.display_name,
    // Rooms created before server-owned member colours used an empty database
    // default. Hydrate them with a stable valid colour so their next snapshot
    // is accepted and naturally repairs the stored projection.
    color: SAFE_COLOR.test(member.color) ? member.color : MEMBER_COLORS[index % MEMBER_COLORS.length],
    system: member.is_system,
    // A member the group carried on without is not counted by the completion
    // gates, and this is the field those gates read.
    joined: member.has_joined && member.is_active,
  }));

  const authoritativeVoteVersions: Record<string, number> = {};
  const versionBySnapshotField: Record<string, number> = {};
  for (const { kind, field, roundField, resolvedField } of VOTE_KINDS) {
    const kindRounds = voteRounds.rows.filter((row) => row.kind === kind);
    const highestRound = maximum(kindRounds.map((row) => row.round));
    const currentRound = clampRound(highestRound, 1);
    const current = kindRounds.find((row) => row.round === currentRound);
    const rows = votes.rows.filter((row) => row.kind === kind);
    const ballots: Record<string, unknown> = {};

    for (const row of rows) {
      if (row.round === currentRound) {
        ballots[row.member_id] = {
          value: row.value,
          round: row.round,
          contentVersion: row.content_version,
        };
      }
    }

    snapshot[field] = ballots;
    if (roundField !== null) snapshot[roundField] = currentRound;
    if (resolvedField !== null) snapshot[resolvedField] = current?.resolved_value ?? "";
    if (kind === "solution") snapshot["solutionTie"] = current?.is_tie === true;

    authoritativeVoteVersions[kind] = maximum([
      ...kindRounds.map((row) => row.content_version),
      ...rows.map((row) => row.content_version),
    ]);
    const versionField = VOTE_VERSION_FIELDS[kind];
    // grouping and groupConfirm deliberately share groupingVersion. Preserve
    // the highest *projected* value instead of letting the later kind overwrite
    // a newer vote with its own lower version, or trusting stale JSONB values.
    if (versionField !== undefined) {
      versionBySnapshotField[versionField] = maximum([
        versionBySnapshotField[versionField] ?? 0,
        authoritativeVoteVersions[kind],
      ]);
      snapshot[versionField] = versionBySnapshotField[versionField];
    }
  }

  snapshot["authoritativeVoteVersions"] = authoritativeVoteVersions;
  return snapshot;
}
