import { now, type Env } from "./env";
import { jobCleanupStatements, type StoredJob } from "./storage-cleanup";

export async function failJob(
  env: Env,
  job: StoredJob,
  message: string,
): Promise<void> {
  const time = now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE hub_uploadjob SET status='failed',error=?,completed_at=? WHERE id=? AND status='pending'",
    ).bind(message, time, job.id),
    env.DB.prepare(
      "UPDATE hub_item SET publish_after_validation=0,status='draft' WHERE id=?",
    ).bind(job.item_id),
    env.DB.prepare("UPDATE worker_job SET lease_until=0 WHERE id=?").bind(
      job.id,
    ),
    ...jobCleanupStatements(env.DB, job, time),
  ]);
}
