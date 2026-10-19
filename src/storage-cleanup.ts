import type { DatabaseTables } from "./database.generated";
import { all, run, type Env } from "./env";
import { PUBLIC_IMAGE_KEY } from "./retention";

export type StorageBucket = "files" | "images" | "quarantine";
export type StoredJob = DatabaseTables["hub_uploadjob"] &
  Pick<DatabaseTables["worker_job"], "object_key" | "output_key">;
type Deletion = DatabaseTables["hub_filedeletion"];

export function queueDeletion(
  db: D1Database,
  bucket: StorageBucket,
  name: string,
  time: string,
  notBefore = 0,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO hub_filedeletion(name,created_at,bucket,not_before) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET bucket=excluded.bucket,not_before=MAX(not_before,excluded.not_before)`,
    )
    .bind(name, time, bucket, notBefore);
}

export function jobCleanupStatements(
  db: D1Database,
  job: Pick<StoredJob, "object_key" | "output_key">,
  time: string,
): D1PreparedStatement[] {
  const statements = [queueDeletion(db, "quarantine", job.object_key, time)];
  if (job.output_key !== null) {
    const bucket: StorageBucket = job.output_key.startsWith("releases/")
      ? "files"
      : "images";
    statements.push(
      db
        .prepare(
          `INSERT INTO hub_filedeletion(name,created_at,bucket)
      SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM hub_release WHERE file=?)
      AND NOT EXISTS(SELECT 1 FROM hub_screenshot WHERE image=?)
      ON CONFLICT(name) DO UPDATE SET bucket=excluded.bucket`,
        )
        .bind(job.output_key, time, bucket, job.output_key, job.output_key),
    );
  }
  return statements;
}

export async function deleteStoredFiles(
  env: Env,
  time = Date.now(),
  names?: string[],
): Promise<void> {
  const failures: unknown[] = [];
  const deletions = await all<Deletion>(
    env.DB,
    names
      ? "SELECT * FROM hub_filedeletion WHERE name IN (SELECT value FROM json_each(?)) ORDER BY attempts,id"
      : "SELECT * FROM hub_filedeletion WHERE not_before<=? ORDER BY attempts,id LIMIT 100",
    ...(names ? [JSON.stringify(names)] : [time]),
  );
  for (const entry of deletions) {
    try {
      if (entry.not_before > time)
        throw new Error("File is still protected by an upload lease");
      const bucket =
        entry.bucket ??
        (PUBLIC_IMAGE_KEY.test(entry.name) ? "images" : "files");
      switch (bucket) {
        case "files":
          await env.FILES.delete(entry.name);
          break;
        case "images":
          await env.PUBLIC_IMAGES.delete(entry.name);
          break;
        case "quarantine":
          await env.QUARANTINE.delete(entry.name);
          break;
        default:
          throw new Error("Unknown deletion bucket");
      }
      await run(env.DB, "DELETE FROM hub_filedeletion WHERE id=?", entry.id);
    } catch (error) {
      failures.push(error);
      // A poison entry must not monopolize the bounded batch on every run.
      try {
        await run(
          env.DB,
          "UPDATE hub_filedeletion SET attempts=attempts+1 WHERE id=?",
          entry.id,
        );
      } catch (retryError) {
        failures.push(retryError);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Stored file cleanup failed");
}
