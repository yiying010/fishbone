import type { PoolClient } from "../../db/pool.ts";
import { readSources, type Snapshot } from "../snapshot.ts";
import type { ProjectionContext } from "../projection.ts";
import { dedupe } from "./shared.ts";

export async function projectMembers(
  client: PoolClient,
  snapshot: Snapshot,
  context: ProjectionContext,
): Promise<void> {
  const sources = dedupe(readSources(snapshot), (source) => source.id);

  await client.query(
    `insert into members (room_id, member_id, display_name, color, is_system, has_joined)
     select $1, t.member_id, t.display_name, t.color, t.is_system, t.has_joined
       from unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::boolean[])
         as t(member_id, display_name, color, is_system, has_joined)
     on conflict (room_id, member_id) do update
       set display_name = case when excluded.display_name = '' then members.display_name
                               else excluded.display_name end,
           color        = excluded.color,
           is_system    = excluded.is_system,
           has_joined   = members.has_joined or excluded.has_joined`,
    [
      context.roomId,
      sources.map((source) => source.id),
      sources.map((source) => source.name),
      sources.map((source) => source.color),
      sources.map((source) => source.system),
      sources.map((source) => source.joined),
    ],
  );

  // A stale client may not know about a newer member, so projection never
  // removes member rows solely because they are absent from one snapshot.
  if (context.memberId !== null) {
    await client.query(
      `update members
          set last_seen_at = now(),
              current_step = greatest(current_step, $3)
        where room_id = $1 and member_id = $2`,
      [context.roomId, context.memberId, context.step ?? 0],
    );
  }
}
