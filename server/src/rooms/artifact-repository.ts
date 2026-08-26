import { withTransaction, type Pool } from "../db/pool.ts";
import { RoomNotFoundError } from "./errors.ts";

export interface ArtifactInput {
  format: string;
  filename: string;
  content: string;
  exportedBy: string | null;
}

/** Persists exported artifacts without exposing room synchronization details. */
export class ArtifactRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async save(code: string, input: ArtifactInput): Promise<{ id: number; revision: number }> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ id: number; revision: number }>(
        `update rooms set last_activity_at = now()
          where lower(code) = lower($1)
          returning id, revision`,
        [code],
      );
      const room = rows[0];
      if (room === undefined) throw new RoomNotFoundError("no such room");

      const { rows: inserted } = await client.query<{ id: number }>(
        `insert into artifacts (room_id, revision, format, filename, content, exported_by)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [room.id, room.revision, input.format, input.filename, input.content, input.exportedBy],
      );
      const id = inserted[0]?.id;
      if (id === undefined) throw new Error("artifact insert returned no row");
      return { id, revision: room.revision };
    });
  }
}
