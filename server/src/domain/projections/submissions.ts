import type { PoolClient } from "../../db/pool.ts";
import { ITEM_KINDS, readItems, type Snapshot } from "../snapshot.ts";
import { dedupe, KEY_SEPARATOR } from "./shared.ts";

export async function projectSubmissions(client: PoolClient, snapshot: Snapshot, roomId: number): Promise<void> {
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
