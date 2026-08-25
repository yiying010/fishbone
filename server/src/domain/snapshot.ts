/**
 * The room snapshot is produced and merged entirely in the browser
 * (`sharedSnapshot()` / `mergeRoom()` in public/fishbone.html). The server
 * stores it verbatim and never rewrites it, so the merge semantics that the
 * activity depends on stay in exactly one place.
 *
 * This module only does what a server must do regardless: reject input that is
 * not a snapshot at all, and read the parts needed for the relational
 * projection in ./projection.ts.
 */

export type Snapshot = Record<string, unknown>;

export interface SnapshotSource {
  id: string;
  name: string;
  color: string;
  system: boolean;
  joined: boolean;
}

export interface SnapshotItem {
  id: string;
  text: string;
  author: string | null;
  status: string;
  payload: Record<string, unknown>;
}

export interface SnapshotProposal {
  id: string;
  author: string | null;
  groups: unknown;
  payload: Record<string, unknown>;
}

export interface SnapshotVote {
  memberId: string;
  value: string;
  round: number;
}

export class SnapshotError extends Error {}

export function assertSnapshot(value: unknown, maxBytes: number): Snapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotError("snapshot must be a JSON object");
  }
  const serialized = JSON.stringify(value);
  const size = Buffer.byteLength(serialized, "utf8");
  if (size > maxBytes) {
    throw new SnapshotError(`snapshot is ${size} bytes, limit is ${maxBytes}`);
  }
  // `sources` is the one field every client version has emitted since the
  // activity gained room codes; its absence means this is not a room snapshot.
  if (!Array.isArray((value as Snapshot)["sources"])) {
    throw new SnapshotError("snapshot is missing the sources array");
  }
  // jsonb rejects U+0000 inside strings. A student pasting one would otherwise
  // wedge the room on a 500 that never clears, so strip it instead.
  const clean = serialized.includes("\\u0000") ? (stripNulls(value) as Snapshot) : (value as Snapshot);
  return clean;
}

const NUL = String.fromCharCode(0);

/** Postgres `text` and `jsonb` both reject U+0000; nothing in this activity needs it. */
export function withoutNul(text: string): string {
  return text.split(NUL).join("");
}

function stripNulls(value: unknown): unknown {
  if (typeof value === "string") return withoutNul(value);
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[withoutNul(key)] = stripNulls(child);
    }
    return out;
  }
  return value;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readSources(snapshot: Snapshot): SnapshotSource[] {
  return array(snapshot["sources"])
    .map(record)
    .filter((source) => str(source["id"]) !== "")
    .map((source) => ({
      id: str(source["id"]),
      name: str(source["name"]),
      color: str(source["color"]),
      system: source["system"] === true,
      joined: source["joined"] === true,
    }));
}

/** Card lists, in the order the activity produces them. `step` is the step that creates the card. */
export const ITEM_KINDS: { kind: string; field: string; step: number }[] = [
  { kind: "distress", field: "distresses", step: 2 },
  { kind: "problem_detail", field: "problemDetails", step: 5 },
  { kind: "cause", field: "causes", step: 7 },
  { kind: "goal_idea", field: "goalIdeas", step: 11 },
  { kind: "method", field: "methods", step: 13 },
  { kind: "reflection", field: "reflections", step: 18 },
];

export function readItems(snapshot: Snapshot, field: string): SnapshotItem[] {
  return array(snapshot[field])
    .map(record)
    .filter((item) => str(item["id"]) !== "")
    .map((item) => {
      const { id, text, source, createdBy, status, ...rest } = item;
      const author = str(createdBy) || str(source);
      return {
        id: str(id),
        text: str(text),
        author: author === "" ? null : author,
        status: str(status),
        payload: rest,
      };
    });
}

/** Grouping / classification proposals, and the snapshot field naming the winner. */
export const PROPOSAL_KINDS: { kind: string; field: string; confirmedField: string }[] = [
  { kind: "distress_grouping", field: "groupProposals", confirmedField: "groupingConfirmed" },
  { kind: "cause_class", field: "causeClassProposals", confirmedField: "causeClassConfirmed" },
  { kind: "method_class", field: "methodClassProposals", confirmedField: "methodClassConfirmed" },
];

export function readProposals(snapshot: Snapshot, field: string): SnapshotProposal[] {
  return array(snapshot[field])
    .map(record)
    .filter((proposal) => str(proposal["id"]) !== "")
    .map((proposal) => {
      const { id, source, groups, ...rest } = proposal;
      const author = str(source);
      return {
        id: str(id),
        author: author === "" ? null : author,
        groups: groups ?? [],
        payload: rest,
      };
    });
}

/**
 * Vote maps and their round counters. `groupConfirm` has no round counter in
 * the snapshot, so it is treated as a single round.
 *
 * `resolvedField` is the snapshot field that records the outcome once the room
 * settles on one, where such a field exists.
 */
export const VOTE_KINDS: { kind: string; field: string; roundField: string | null; resolvedField: string | null }[] = [
  { kind: "grouping", field: "groupingVotes", roundField: "groupingRound", resolvedField: "groupingConfirmed" },
  { kind: "groupConfirm", field: "groupConfirmVotes", roundField: null, resolvedField: "groupingConfirmed" },
  { kind: "problem", field: "problemVotes", roundField: "problemRound", resolvedField: "selected" },
  { kind: "problemDraft", field: "problemDraftVotes", roundField: "problemDraftRound", resolvedField: "problem" },
  { kind: "causeClass", field: "causeClassVotes", roundField: "causeClassRound", resolvedField: "causeClassConfirmed" },
  { kind: "right", field: "rightVotes", roundField: "rightRound", resolvedField: null },
  { kind: "goalDraft", field: "goalDraftVotes", roundField: "goalDraftRound", resolvedField: "goal" },
  { kind: "methodClass", field: "methodClassVotes", roundField: "methodClassRound", resolvedField: "methodClassConfirmed" },
  { kind: "outcome", field: "outcomeVotes", roundField: "outcomeRound", resolvedField: null },
  { kind: "outcomeRevision", field: "outcomeRevisionVotes", roundField: "outcomeRevisionRound", resolvedField: "outcomeRevisionTarget" },
  { kind: "solution", field: "solutionVotes", roundField: "solutionRound", resolvedField: "feasible" },
];

/**
 * A ballot is either a bare value or `{value, round}`. The bare form predates
 * re-voting and belongs to the map's current round.
 */
export function readVotes(snapshot: Snapshot, field: string, roundField: string | null): SnapshotVote[] {
  const currentRound = readRound(snapshot, roundField);
  const votes = record(snapshot[field]);
  const out: SnapshotVote[] = [];
  for (const [memberId, ballot] of Object.entries(votes)) {
    if (memberId === "") continue;
    if (ballot !== null && typeof ballot === "object" && !Array.isArray(ballot)) {
      const cast = ballot as Record<string, unknown>;
      const value = str(cast["value"]);
      if (value === "") continue;
      out.push({ memberId, value, round: clampRound(cast["round"], currentRound) });
    } else if (typeof ballot === "string" && ballot !== "") {
      out.push({ memberId, value: ballot, round: currentRound });
    }
  }
  return out;
}

/**
 * Round counters end up in an `int` column. A snapshot claiming round 1e10
 * would otherwise abort the whole write, and because the write and the
 * projection share one transaction, the room would reject every later write
 * too. Clamping keeps one malformed payload from bricking a room.
 */
const MAX_ROUND = 1_000_000;

export function clampRound(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(MAX_ROUND, parsed);
}

export function readRound(snapshot: Snapshot, roundField: string | null): number {
  return roundField === null ? 1 : clampRound(snapshot[roundField], 1);
}

export function readString(snapshot: Snapshot, field: string): string {
  return str(snapshot[field]);
}

export function readBoolean(snapshot: Snapshot, field: string): boolean {
  return snapshot[field] === true;
}
