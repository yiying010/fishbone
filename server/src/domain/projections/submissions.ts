import type { PoolClient } from "../../db/pool.ts";
import { ITEM_KINDS, monotonicVersion, readItems, type Snapshot } from "../snapshot.ts";
import { dedupe, KEY_SEPARATOR } from "./shared.ts";

export async function projectSubmissions(
  client: PoolClient,
  snapshot: Snapshot,
  roomId: number,
  memberId: string | null,
): Promise<void> {
  const collected = ITEM_KINDS.flatMap(({ kind, field, step }) =>
    readItems(snapshot, field).map((item) => ({ kind, field, step, item })),
  );
  const rows = dedupe(collected, (row) => row.kind + KEY_SEPARATOR + row.item.id);
  const versionFor = (row: (typeof rows)[number]) =>
    monotonicVersion(
      row.item.payload["contentVersion"]
        ?? row.item.payload["version"]
        ?? row.item.payload["updatedAt"]
        ?? snapshot[`${row.field}Version`],
    );
  const inlineTombstones = new Set(rows.filter((row) =>
    (row.item.payload["deletedAt"] !== undefined
      && row.item.payload["deletedAt"] !== null
      && row.item.payload["deletedAt"] !== "")
      || (row.kind === "reflection" && row.item.text.trim() === "" && versionFor(row) > 0),
  ));
  const liveRows = rows.filter((row) => !inlineTombstones.has(row));

  const kinds = liveRows.map((row) => row.kind);
  const ids = liveRows.map((row) => row.item.id);
  const steps = liveRows.map((row) => row.step);
  const authors = liveRows.map((row) => row.item.author);
  const bodies = liveRows.map((row) => row.item.text);
  const statuses = liveRows.map((row) => row.item.status);
  const payloads = liveRows.map((row) => JSON.stringify(row.item.payload));
  const versions = liveRows.map(versionFor);

  await client.query(
    `insert into submissions
       (room_id, kind, item_id, step, author_member_id, body, status, payload, content_version)
     select $1, t.kind, t.item_id, t.step, t.author, t.body, t.status,
            t.payload::jsonb, t.content_version
       from unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::bigint[])
         as t(kind, item_id, step, author, body, status, payload, content_version)
     on conflict (room_id, kind, item_id) do update
       set step             = excluded.step,
           author_member_id = coalesce(excluded.author_member_id, submissions.author_member_id),
           body             = excluded.body,
           status           = excluded.status,
           payload          = excluded.payload,
           content_version  = excluded.content_version,
           deleted_at       = null,
           updated_at       = now()
       where excluded.content_version > submissions.content_version
         and excluded.content_version > submissions.deleted_version`,
    [roomId, kinds, ids, steps, authors, bodies, statuses, payloads, versions],
  );

  // Snapshot absence is never a deletion. A card is hidden only by an explicit
  // tombstone, which arrives either inline on the item (`deletedAt`) or as an
  // id in the matching deleted-id collection.
  const deletedFields: Record<string, string> = {
    distress: "deletedDistressIds",
    problem_detail: "deletedProblemDetailIds",
    cause: "deletedCauseIds",
    goal_idea: "deletedGoalIdeaIds",
    method: "deletedMethodIds",
  };
  const tombstones = new Map<string, { kind: string; itemId: string; deletedVersion: number }>();
  const remember = (kind: string, itemId: string, deletedVersion: number): void => {
    const key = kind + KEY_SEPARATOR + itemId;
    const existing = tombstones.get(key);
    if (existing === undefined || deletedVersion > existing.deletedVersion) {
      tombstones.set(key, { kind, itemId, deletedVersion });
    }
  };
  for (const row of inlineTombstones) remember(row.kind, row.item.id, versionFor(row));
  const liveKeys = new Set(liveRows.map((row) => row.kind + KEY_SEPARATOR + row.item.id));
  for (const { kind, field } of ITEM_KINDS) {
    const deletedField = deletedFields[kind];
    if (deletedField === undefined) continue;
    const deleted = Array.isArray(snapshot[deletedField]) ? snapshot[deletedField] : [];
    const version = monotonicVersion(snapshot[`${field}Version`]);
    for (const itemId of deleted) {
      if (typeof itemId !== "string" || itemId === "") continue;
      // A snapshot that both keeps and deletes the same card contradicts
      // itself; treat the live copy as the intent and ignore the id.
      if (liveKeys.has(kind + KEY_SEPARATOR + itemId)) continue;
      remember(kind, itemId, version);
    }
  }
  const tombstoneRows = [...tombstones.values()];

  /*
   * Every tombstone must target an existing card owned by the authenticated
   * author. Creating a row for a missing id would let one member pre-empt
   * another member's future card, and skipping the author check would let any
   * member erase a card that is not theirs. One batched update keeps this work
   * bounded while the room row lock is held.
   *
   * The stored version is raised past the current content rather than compared
   * against it. Clients version a card with a wall-clock timestamp but version
   * the collection it lives in with a plain counter, so the two are not
   * comparable. This write is safe without that comparison because it only
   * runs after the compare-and-set on `rooms.revision` succeeded: the client
   * had the current card when it said the card is gone, and no client path
   * ever removes an id from a deleted-id collection.
   */
  await client.query(
    `update submissions as existing
        set deleted_version = greatest(tombstone.deleted_version, existing.content_version + 1),
            deleted_at      = now(),
            updated_at      = now()
       from unnest($2::text[], $3::text[], $4::bigint[])
         as tombstone(kind, item_id, deleted_version)
      where existing.room_id = $1
        and existing.kind = tombstone.kind
        and existing.item_id = tombstone.item_id
        and tombstone.deleted_version > existing.deleted_version
        and (existing.author_member_id = $5 or existing.author_member_id in ('group', 'unknown'))`,
    [
      roomId,
      tombstoneRows.map((row) => row.kind),
      tombstoneRows.map((row) => row.itemId),
      tombstoneRows.map((row) => row.deletedVersion),
      memberId,
    ],
  );
}
