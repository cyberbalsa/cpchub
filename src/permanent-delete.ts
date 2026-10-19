import { HttpError, type Env } from "./env";
import { deleteStoredFiles } from "./storage-cleanup";

export type PurgeKind = "item" | "user" | "release" | "screenshot";

// Capture storage keys and remove references in one transaction. Every mutation
// uses the same active-upload guard so a validator cannot recreate wiped files.
export async function permanentlyDelete(
  env: Env,
  kind: PurgeKind,
  id: string | number,
) {
  const items =
    kind === "user"
      ? "SELECT id FROM hub_item WHERE author_id=?"
      : "SELECT id FROM hub_item WHERE id=?";
  const whole = kind === "user" || kind === "item";
  const releases = whole
    ? `item_id IN (${items})`
    : kind === "release"
      ? "id=?"
      : "0";
  const screenshots = whole
    ? `item_id IN (${items})`
    : kind === "screenshot"
      ? "id=?"
      : "0";
  const jobs = whole ? `item_id IN (${items})` : `${kind}_id=?`;
  const guard = `NOT EXISTS(SELECT 1 FROM worker_job w JOIN hub_uploadjob j ON j.id=w.id WHERE (${jobs}) AND w.lease_until>${Date.now()})`;
  const prepare = (sql: string) =>
    env.DB.prepare(sql).bind(...Array.from(sql.matchAll(/\?/g), () => id));
  const statements = [
    prepare(`SELECT object_key name FROM worker_job WHERE id IN (SELECT id FROM hub_uploadjob WHERE ${jobs}) AND ${guard}
      UNION SELECT output_key name FROM worker_job WHERE id IN (SELECT id FROM hub_uploadjob WHERE ${jobs}) AND output_key IS NOT NULL AND ${guard}
      UNION SELECT file name FROM hub_release WHERE (${releases}) AND ${guard}
      UNION SELECT image name FROM hub_screenshot WHERE (${screenshots}) AND ${guard}`),
  ];
  if (whole) {
    for (const table of ["hub_accountactivity", "hub_moderationlog"])
      statements.push(
        prepare(
          `DELETE FROM ${table} WHERE (item_id IN (${items})${kind === "user" ? (table === "hub_moderationlog" ? " OR target_user_id=? OR actor_id=?" : " OR user_id=?") : ""}) AND ${guard}`,
        ),
      );
  } else if (kind === "release") {
    for (const table of ["hub_downloadip", "hub_downloaduser"])
      statements.push(
        prepare(`DELETE FROM ${table} WHERE release_id=? AND ${guard}`),
      );
  }
  // Remove completed upload metadata too; FK SET NULL would otherwise retain it.
  statements.push(
    prepare(`DELETE FROM hub_uploadjob WHERE (${jobs}) AND ${guard}`),
  );
  if (!whole)
    statements.push(
      prepare(
        `UPDATE hub_item SET status='draft',publish_after_validation=0,content_revision=content_revision+1 WHERE id IN (SELECT item_id FROM hub_${kind} WHERE id=?) AND ${guard}`,
      ),
    );
  statements.push(
    prepare(
      `DELETE FROM ${kind === "user" ? "auth_user" : "hub_" + kind} WHERE id=? AND ${guard} RETURNING id`,
    ),
  );
  const results = await env.DB.batch<{ name: string; id?: string | number }>(
    statements,
  );
  if (!results.at(-1)!.results.length)
    throw new HttpError(
      409,
      "An upload is still processing. Try permanent deletion again when it finishes; nothing was deleted.",
    );
  const names = results[0]!.results.map((row) => row.name).filter(Boolean);
  try {
    if (names.length) await deleteStoredFiles(env, Date.now(), names);
  } catch {
    throw new HttpError(
      503,
      "The records were permanently deleted, but some files could not be removed. File cleanup will retry automatically; the wipe is not complete yet.",
    );
  }
}
