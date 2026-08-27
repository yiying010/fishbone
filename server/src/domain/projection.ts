/** Coordinates relational projections for an accepted room snapshot. */

import type { PoolClient } from "../db/pool.ts";
import { projectGroupings } from "./projections/groupings.ts";
import { projectMembers } from "./projections/members.ts";
import { projectSubmissions } from "./projections/submissions.ts";
import { projectVotes } from "./projections/votes.ts";
import type { Snapshot } from "./snapshot.ts";

export interface ProjectionContext {
  roomId: number;
  /** The member whose POST produced this snapshot, if any. */
  memberId: string | null;
  /** That member's own step counter; the room's step is the furthest any member has reached. */
  step: number | null;
}

/**
 * Runs all derived-table writes inside the transaction owned by the caller.
 * Member projection stays first because grouping titles depend on member names.
 */
export async function projectSnapshot(
  client: PoolClient,
  snapshot: Snapshot,
  context: ProjectionContext,
): Promise<void> {
  const { roomId } = context;
  await projectMembers(client, snapshot, context);
  await projectSubmissions(client, snapshot, roomId, context.memberId);
  await projectGroupings(client, snapshot, roomId);
  await projectVotes(client, snapshot, roomId);

  await client.query(
    `update rooms
        set current_step = coalesce((select max(current_step) from members where room_id = $1), 0)
      where id = $1`,
    [roomId],
  );
}
