/**
 * The room snapshot is produced and merged entirely in the browser
 * (`sharedSnapshot()` / `mergeRoom()` in public/fishbone.html). The server
 * stores submitted JSONB as a compatibility base. Hydrate and conflict replies
 * replace projected official fields with the PostgreSQL-authoritative union.
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
  contentVersion: number;
}

export class SnapshotError extends Error {}

export function assertSnapshot(value: unknown, maxBytes: number): Snapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotError("snapshot must be a JSON object");
  }
  assertSnapshotStructure(value);
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

/**
 * Ceiling for any value that ends up in a btree primary key, and for the
 * display name that is copied into `groupings.title`.
 *
 * A btree index row cannot exceed roughly 2704 bytes, and a 3 KB id fits
 * comfortably inside the 1 MB snapshot budget. Without this, one such id makes
 * the projection insert fail, which rolls back the whole write transaction, so
 * the revision never advances and the device retries the same payload forever.
 * The dedupe and round-clamping guards elsewhere in this module exist for the
 * same class of problem; length was the case they missed.
 *
 * Truncating rather than rejecting is deliberate: a malformed payload must not
 * be able to lock a student out of syncing their work.
 */
const MAX_KEY_LENGTH = 200;
const MAX_NAME_LENGTH = 200;

function key(value: unknown): string {
  return str(value).slice(0, MAX_KEY_LENGTH);
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
      id: key(source["id"]),
      // Capped for the same reason MAX_DISPLAY_NAME caps the join path: without
      // it a name arriving this way could be a megabyte long, and it is copied
      // verbatim into groupings.title.
      name: str(source["name"]).slice(0, MAX_NAME_LENGTH),
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
      const author = key(createdBy) || key(source);
      return {
        id: key(id),
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
      const author = key(source);
      return {
        id: key(id),
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
  for (const [rawMemberId, ballot] of Object.entries(votes)) {
    if (rawMemberId === "") continue;
    // Both sides of a vote land in the primary key of `votes`.
    const memberId = key(rawMemberId);
    if (ballot !== null && typeof ballot === "object" && !Array.isArray(ballot)) {
      const cast = ballot as Record<string, unknown>;
      const value = key(cast["value"]);
      if (value === "") continue;
      out.push({
        memberId,
        value,
        round: clampRound(cast["round"], currentRound),
        contentVersion: monotonicVersion(cast["contentVersion"]),
      });
    } else if (typeof ballot === "string" && ballot !== "") {
      out.push({ memberId, value: key(ballot), round: currentRound, contentVersion: 0 });
    }
  }
  return out;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const SAFE_COLOR = /^#[0-9A-Fa-f]{6}$/;
const ID_FIELDS = new Set(["id", "source", "createdBy", "updatedBy", "memberId", "catId", "groupId", "from"]);
const ID_ARRAY_FIELDS = new Set([
  "ids",
  "priority",
  "deletedDistressIds",
  "deletedCauseIds",
  "deletedMethodIds",
]);
const ID_MAP_FIELDS = new Set([
  "confirmBy",
  "draftAssignments",
  "draftCauseAssignments",
  "draftMethodAssignments",
  "groupingVotes",
  "groupConfirmVotes",
  "problemVotes",
  "problemDraftVotes",
  "causeClassVotes",
  "rightVotes",
  "goalDraftVotes",
  "methodClassVotes",
  "outcomeVotes",
  "outcomeRevisionVotes",
  "solutionVotes",
]);

function assertSafeId(value: unknown, field: string): void {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new SnapshotError(`${field} must contain only letters, digits, _ or -`);
  }
}

/** Bounds recursion and identifiers before legacy DOM code sees the snapshot. */
function assertSnapshotStructure(root: object): void {
  const pending: { value: unknown; depth: number; field: string }[] = [
    { value: root, depth: 0, field: "snapshot" },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > 64) throw new SnapshotError("snapshot is nested too deeply");
    nodes += 1;
    if (nodes > 20_000) throw new SnapshotError("snapshot has too many values");
    if (Array.isArray(current.value)) {
      for (const [index, child] of current.value.entries()) {
        pending.push({ value: child, depth: current.depth + 1, field: `${current.field}[${index}]` });
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    for (const [field, child] of Object.entries(current.value as Record<string, unknown>)) {
      if (ID_FIELDS.has(field)) assertSafeId(child, field);
      if (field === "color" && (typeof child !== "string" || !SAFE_COLOR.test(child))) {
        throw new SnapshotError(`${current.field}.color must be a #RRGGBB value`);
      }
      if (ID_ARRAY_FIELDS.has(field)) {
        if (!Array.isArray(child)) throw new SnapshotError(`${field} must be an array of identifiers`);
        for (const id of child) assertSafeId(id, field);
      }
      // Top-level causes contains card objects; method.causes contains ids.
      if (field === "causes" && Array.isArray(child)) {
        for (const cause of child) {
          if (typeof cause === "string") assertSafeId(cause, field);
        }
      }
      if (ID_MAP_FIELDS.has(field) && child !== null && typeof child === "object" && !Array.isArray(child)) {
        for (const mapKey of Object.keys(child as Record<string, unknown>)) assertSafeId(mapKey, field);
      }
      pending.push({ value: child, depth: current.depth + 1, field: `${current.field}.${field}` });
    }
  }
}

export function monotonicVersion(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, Number.MAX_SAFE_INTEGER);
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
