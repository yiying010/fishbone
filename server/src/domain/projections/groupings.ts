import type { PoolClient } from "../../db/pool.ts";
import { PROPOSAL_KINDS, readProposals, readString, type Snapshot } from "../snapshot.ts";
import { dedupe, KEY_SEPARATOR } from "./shared.ts";

export async function projectGroupings(client: PoolClient, snapshot: Snapshot, roomId: number): Promise<void> {
  const collected = PROPOSAL_KINDS.flatMap(({ kind, field, confirmedField }) => {
    const confirmed = readString(snapshot, confirmedField);
    return readProposals(snapshot, field).map((proposal) => ({
      kind,
      proposal,
      official: confirmed !== "" && confirmed === proposal.id,
    }));
  });
  const rows = dedupe(collected, (row) => row.kind + KEY_SEPARATOR + row.proposal.id);

  const kinds = rows.map((row) => row.kind);
  const ids = rows.map((row) => row.proposal.id);
  const authors = rows.map((row) => row.proposal.author);
  const officials = rows.map((row) => row.official);
  const groups = rows.map((row) => JSON.stringify(row.proposal.groups));
  const payloads = rows.map((row) => JSON.stringify(row.proposal.payload));

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
