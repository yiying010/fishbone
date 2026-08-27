import type { PoolClient } from "../../db/pool.ts";
import { ITEM_KINDS, monotonicVersion, readItems, type Snapshot } from "../snapshot.ts";
import { dedupe, KEY_SEPARATOR } from "./shared.ts";

export async function projectSubmissions(client: PoolClient, snapshot: Snapshot, roomId: number): Promise<void> {
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

  for (const row of inlineTombstones) {
    await client.query(
      `insert into submissions
         (room_id, kind, item_id, step, author_member_id, body, status, payload, deleted_version, deleted_at)
       values ($1, $2, $3, $4, $5, '', $6, $7::jsonb, $8, now())
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
        row.kind,
        row.item.id,
        row.step,
        row.item.author,
        row.item.status,
        JSON.stringify(row.item.payload),
        versionFor(row),
      ],
    );
  }

  // Snapshot absence is never a deletion. Only explicit collection tombstones
  // are allowed to hide a card, and only when their version is newer.
  const deletedFields: Record<string, string> = {
    distress: "deletedDistressIds",
    problem_detail: "deletedProblemDetailIds",
    cause: "deletedCauseIds",
    goal_idea: "deletedGoalIdeaIds",
    method: "deletedMethodIds",
  };
  for (const { kind, field, step } of ITEM_KINDS) {
    const deletedField = deletedFields[kind];
    if (deletedField === undefined) continue;
    const deleted = Array.isArray(snapshot[deletedField]) ? snapshot[deletedField] : [];
    const version = monotonicVersion(snapshot[`${field}Version`]);
    for (const itemId of deleted) {
      if (typeof itemId !== "string" || itemId === "") continue;
      await client.query(
        `insert into submissions (room_id, kind, item_id, step, deleted_version, deleted_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (room_id, kind, item_id) do update
           set deleted_version = excluded.deleted_version,
               deleted_at      = excluded.deleted_at,
               updated_at      = now()
         where excluded.deleted_version > submissions.deleted_version
           and excluded.deleted_version > submissions.content_version`,
        [roomId, kind, itemId, step, version],
      );
    }
  }
}
