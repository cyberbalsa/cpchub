import { all, run, type Env } from "./env";
import { deleteStoredFiles, type StoredJob } from "./storage-cleanup";
import { failJob } from "./upload-state";
import {
  JOB_LEASE_MS,
  RETENTION_MS,
  UPLOAD_TIMEOUT_MS,
  UPLOAD_WINDOW_MS,
} from "./retention";

export async function maintenance(env: Env): Promise<void> {
  const time = Date.now(),
    stamp = new Date(time).toISOString();
  const cutoff = new Date(time - RETENTION_MS).toISOString();
  const failures: unknown[] = [];
  const attempt = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };

  // Privacy expiry must be independent of upload processing and object storage.
  for (const table of [
    "worker_session",
    "worker_login",
    "worker_nonce",
    "worker_oauth_code",
    "worker_token",
    "worker_passkey_challenge",
  ]) {
    await attempt(() =>
      run(env.DB, `DELETE FROM ${table} WHERE expires_at<=?`, time),
    );
  }
  await attempt(() =>
    run(
      env.DB,
      "DELETE FROM hub_accountactivity WHERE julianday(created_at)<=julianday(?)",
      cutoff,
    ),
  );
  await attempt(() =>
    run(
      env.DB,
      "DELETE FROM hub_downloadip WHERE julianday(expires_at)<=julianday(?)",
      stamp,
    ),
  );
  await attempt(() =>
    run(
      env.DB,
      "DELETE FROM hub_uploadevent WHERE julianday(created_at)<=julianday(?)",
      new Date(time - UPLOAD_WINDOW_MS).toISOString(),
    ),
  );

  await attempt(async () => {
    const jobs = await all<StoredJob>(
      env.DB,
      `SELECT j.*,w.object_key,w.output_key,w.lease_until,w.attempts
      FROM hub_uploadjob j JOIN worker_job w ON w.id=j.id
      WHERE j.status='pending' AND julianday(j.created_at)<=julianday(?) AND w.lease_until<=?`,
      new Date(time - UPLOAD_TIMEOUT_MS).toISOString(),
      time,
    );
    for (const job of jobs)
      await attempt(async () => {
        // A queue consumer may have started since the SELECT. Claim the job
        // before timing it out, using the same atomic lease as the consumer.
        const claimed = await run(
          env.DB,
          `UPDATE worker_job SET lease_until=? WHERE id=? AND lease_until<=?
          AND EXISTS(SELECT 1 FROM hub_uploadjob WHERE id=? AND status='pending')`,
          time + JOB_LEASE_MS,
          job.id,
          time,
          job.id,
        );
        if (claimed.meta.changes)
          await failJob(env, job, "Validation timed out. Please upload again.");
      });
  });

  await attempt(async () => {
    const items = await all<{ id: string }>(
      env.DB,
      `SELECT id FROM hub_item WHERE julianday(deleted_at)<=julianday(?)
      AND NOT EXISTS(SELECT 1 FROM hub_uploadjob j JOIN worker_job w ON w.id=j.id WHERE j.item_id=hub_item.id AND w.lease_until>?)
      ORDER BY deleted_at,id LIMIT 20`,
      cutoff,
      time,
    );
    for (const item of items)
      await attempt(() =>
        run(
          env.DB,
          `DELETE FROM hub_item WHERE id=? AND julianday(deleted_at)<=julianday(?)
      AND NOT EXISTS(SELECT 1 FROM hub_uploadjob j JOIN worker_job w ON w.id=j.id WHERE j.item_id=hub_item.id AND w.lease_until>?)`,
          item.id,
          cutoff,
          time,
        ),
      );
  });

  await attempt(() => deleteStoredFiles(env, time));
  await attempt(async () => {
    const jobs = await all<{ id: string }>(
      env.DB,
      `SELECT j.id FROM hub_uploadjob j JOIN worker_job w ON w.id=j.id
      WHERE j.status='pending' AND w.lease_until<=? ORDER BY j.created_at,j.id LIMIT 64`,
      time,
    );
    for (const job of jobs)
      await attempt(() => env.UPLOADS.send({ id: job.id }));
  });
  if (failures.length)
    throw new AggregateError(failures, "Maintenance did not finish every task");
}
