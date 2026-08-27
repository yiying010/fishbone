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
  const inlineTombstones = rows.filter((row) =>
    (row.item.payload["deletedAt"] !== undefined
      && row.item.payload["deletedAt"] !== null
      && row.item.payload["deletedAt"] !== "")
      || (row.kind === "reflection" && row.item.text.trim() === "" && versionFor(row) > 0),
  );
  const liveRows = rows.filter((row) => !inlineTombstones.includes(row));

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

  const tombstoneKinds = inlineTombstones.map((row) => row.kind);
  const tombstoneIds = inlineTombstones.map((row) => row.item.id);
  const tombstoneSteps = inlineTombstones.map((row) => row.step);
  const tombstoneAuthors = inlineTombstones.map((row) => row.item.author);
  const tombstoneStatuses = inlineTombstones.map((row) => row.item.status);
  const tombstonePayloads = inlineTombstones.map((row) => JSON.stringify(row.item.payload));
  const tombstoneVersions = inlineTombstones.map(versionFor);
  await client.query(
    `insert into submissions
       (room_id, kind, item_id, step, author_member_id, body, status, payload, deleted_version, deleted_at)
     select $1, t.kind, t.item_id, t.step, t.author, '', t.status,
            t.payload::jsonb, t.deleted_version, now()
       from unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::bigint[])
         as t(kind, item_id, step, author, status, payload, deleted_version)
       on conflict (room_id, kind, item_id) do update
         set author_member_id = coalesce(excluded.author_member_id, submissions.author_member_id),
             status           = excluded.status,
             payload          = excluded.payload,
             deleted_version  = excluded.deleted_version,
             deleted_at       = excluded.deleted_at,
             updated_at       = now()
       where excluded.deleted_version > submissions.deleted_version
         and excluded.deleted_version > submissions.content_version`,
    [
      roomId,
      tombstoneKinds,
      tombstoneIds,
      tombstoneSteps,
      tombstoneAuthors,
      tombstoneStatuses,
      tombstonePayloads,
      tombstoneVersions,
    ],
  );

  // Snapshot absence is never a deletion. Only explicit collection tombstones
  // are allowed to hide a card, and only when their version is newer.
  const deletedFields: Record<string, string> = {
    distress: "deletedDistressIds",
    problem_detail: "deletedProblemDetailIds",
    cause: "deletedCauseIds",
    goal_idea: "deletedGoalIdeaIds",
    method: "deletedMethodIds",
  };
  const collectionTombstones: { kind: string; itemId: string; deletedVersion: number }[] = [];
  for (const { kind, field } of ITEM_KINDS) {
    const deletedField = deletedFields[kind];
    if (deletedField === undefined) continue;
    const deleted = Array.isArray(snapshot[deletedField]) ? snapshot[deletedField] : [];
    const version = monotonicVersion(snapshot[`${field}Version`]);
    for (const itemId of deleted) {
      if (typeof itemId !== "string" || itemId === "") continue;
      collectionTombstones.push({ kind, itemId, deletedVersion: version });
    }
  }
  const collectionRows = dedupe(
    collectionTombstones,
    (row) => row.kind + KEY_SEPARATOR + row.itemId,
  );
  // Collection tombstones must target an existing card owned by the
  // authenticated author. Do not create a tombstone for a missing id: that
  // would let one member pre-empt another member's future card. One batched
  // update keeps this work bounded while the room row lock is held.
  await client.query(
    `update submissions as existing
        set deleted_version = tombstone.deleted_version,
            deleted_at      = now(),
            updated_at      = now()
       from unnest($2::text[], $3::text[], $4::bigint[])
         as tombstone(kind, item_id, deleted_version)
      where existing.room_id = $1
        and existing.kind = tombstone.kind
        and existing.item_id = tombstone.item_id
        and tombstone.deleted_version > existing.deleted_version
        and tombstone.deleted_version > existing.content_version
        and (existing.author_member_id = $5 or existing.author_member_id in ('group', 'unknown'))`,
    [
      roomId,
      collectionRows.map((row) => row.kind),
      collectionRows.map((row) => row.itemId),
      collectionRows.map((row) => row.deletedVersion),
      memberId,
    ],
  );
}
