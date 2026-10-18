import { createHash } from "node:crypto";
import { UploadedFile } from "./multipart";
import {
  type Env,
  type User,
  one,
  run,
  now,
  uuid,
  publicId,
  HttpError,
  hash,
} from "./env";
import type { DatabaseTables } from "./database.generated";
import { failJob } from "./upload-state";
import { jobCleanupStatements, type StoredJob } from "./storage-cleanup";
import {
  fileStatistics,
  uploadMetadata,
  type FileStatistics,
} from "./upload-schemas";
import { JOB_LEASE_MS } from "./retention";
import { normalizeText } from "./text-input";
export { maintenance } from "./maintenance";
type UploadKind = "release" | "screenshot";
type UploadItem = { id: string; type_slug: string };
type UploadRow = DatabaseTables["hub_uploadjob"];

export async function submit(
  env: Env,
  user: User,
  item: UploadItem,
  file: File | UploadedFile | null,
  kind: UploadKind,
  data: Record<string, unknown>,
) {
  const setting = await one<DatabaseTables["hub_uploadsettings"]>(
    env.DB,
    "SELECT max_file_mb FROM hub_uploadsettings WHERE id=1",
  );
  const max =
    kind === "screenshot"
      ? 10 * 1024 * 1024
      : (setting?.max_file_mb || 15) * 1024 * 1024;
  if (
    !file ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > max
  )
    throw new HttpError(400, "File exceeds the upload size limit.");
  const name = normalizeText(file.name)
    .replace(/^.*[\\/]/, "")
    .slice(0, 255);
  const extension = item.type_slug === "blueprints" ? ".cpbp" : ".cpcs";
  if (kind === "release" && !name.toLowerCase().endsWith(extension))
    throw new HttpError(400, "Incorrect native file extension.");
  const version = String(data.version || "").trim();
  if (
    kind === "release" &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._+ -]{0,39}$/.test(version)
  )
    throw new HttpError(400, "Invalid version.");
  const metadata = uploadMetadata.parse({
    version,
    game_version: String(data.game_version || "").slice(0, 40),
    changelog: String(data.changelog || "").slice(0, 10000),
    caption: String(data.caption || "").slice(0, 180),
    type: item.type_slug,
  });
  const id = uuid(),
    key = file instanceof UploadedFile ? file.key : "incoming/" + id;
  let digest: string;
  if (file instanceof UploadedFile) digest = file.digest;
  else {
    const bytes = await file.arrayBuffer();
    digest = await hash(bytes);
    await env.QUARANTINE.put(key, bytes);
  }
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO hub_uploadjob(id,kind,status,original_filename,size,sha256,metadata,error,created_at,completed_at,item_id,release_id,screenshot_id,submitted_by_id) VALUES (?,?,'pending',?,?,?,?,'',?,NULL,?,NULL,NULL,?)",
      ).bind(
        id,
        kind,
        name,
        file.size,
        digest,
        JSON.stringify(metadata),
        now(),
        item.id,
        user.id,
      ),
      env.DB.prepare("INSERT INTO worker_job(id,object_key) VALUES (?,?)").bind(
        id,
        key,
      ),
      env.DB.prepare(
        "UPDATE hub_item SET publish_after_validation=CASE WHEN status='published' THEN 1 ELSE publish_after_validation END,status='draft' WHERE id=?",
      ).bind(item.id),
    ]);
  } catch (error) {
    await env.QUARANTINE.delete(key);
    const message = String(error);
    if (message.includes("upload_quota"))
      throw new HttpError(429, "16 uploads per hour. Try again later.");
    if (message.includes("queue_full"))
      throw new HttpError(503, "Upload queue is full.");
    if (message.includes("screenshot_limit"))
      throw new HttpError(400, "Maximum eight screenshots.");
    if (message.includes("duplicate_version"))
      throw new HttpError(400, "Version already exists.");
    throw error;
  }
  // The database is the outbox; maintenance retries publication after an outage.
  await env.UPLOADS.send({ id }).catch(() => {});
  const job = await one<UploadRow>(
    env.DB,
    "SELECT * FROM hub_uploadjob WHERE id=?",
    id,
  );
  if (!job) throw new HttpError(409, "Creation was deleted while uploading.");
  return jobJSON(job);
}

export function jobJSON(job: UploadRow) {
  return {
    id: publicId(job.id),
    kind: job.kind,
    status: job.status,
    get_status_display:
      job.status === "pending"
        ? "Checking"
        : job.status === "passed"
          ? "Passed"
          : "Failed",
    original_filename: job.original_filename,
    error: job.error,
    release: job.release_id ? publicId(job.release_id) : null,
    screenshot: job.screenshot_id ? publicId(job.screenshot_id) : null,
    created_at: job.created_at,
    completed_at: job.completed_at,
  };
}

async function persistOutput(env: Env, id: string, outputKey: string) {
  const saved = await run(
    env.DB,
    "UPDATE worker_job SET output_key=? WHERE id=?",
    outputKey,
    id,
  );
  if (!saved.meta.changes)
    throw new Error("Creation was deleted during validation");
}

export async function processJob(env: Env, id: string): Promise<void> {
  const job = await one<StoredJob>(
    env.DB,
    "SELECT j.*,w.object_key,w.output_key FROM hub_uploadjob j JOIN worker_job w ON w.id=j.id WHERE j.id=? AND j.status='pending'",
    id,
  );
  if (!job) return;
  const claimed = await run(
    env.DB,
    `UPDATE worker_job SET lease_until=?,attempts=attempts+1
    WHERE id=? AND lease_until<=? AND EXISTS(SELECT 1 FROM hub_uploadjob WHERE id=? AND status='pending')`,
    Date.now() + JOB_LEASE_MS,
    id,
    Date.now(),
    id,
  );
  if (!claimed.meta.changes) return;
  try {
    const item = await one<{ id: string }>(
      env.DB,
      "SELECT id FROM hub_item WHERE id=? AND deleted_at IS NULL",
      job.item_id,
    );
    if (!item) {
      await failJob(env, job, "Creation was deleted.");
      return;
    }
    const object = await env.QUARANTINE.get(job.object_key);
    if (!object) {
      await failJob(env, job, "Upload is missing. Please upload again.");
      return;
    }
    const metadata = uploadMetadata.parse(JSON.parse(job.metadata) as unknown);
    const screenshot = job.kind === "screenshot",
      service = screenshot ? env.IMAGE_VALIDATOR : env.VALIDATOR;
    const response = await service.fetch("https://validator/validate", {
      method: "POST",
      body: object.body,
      headers: {
        "x-kind": metadata.type === "blueprints" ? "blueprint" : "scenario",
        "x-size": String(job.size),
      },
    });
    if (response.status === 422) {
      await failJob(
        env,
        job,
        "File failed validation or exceeds the supported resource limits.",
      );
      return;
    }
    if (!response.ok) throw new Error("Validator unavailable");
    let outputKey: string,
      stats: FileStatistics | Record<string, never> = {};
    if (screenshot) {
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024)
        throw new Error("Invalid result");
      const digest = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-512", bytes)),
      ]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      outputKey =
        job.output_key ||
        crypto.randomUUID() + "-" + digest.slice(-16) + ".webp";
      // Persist the write intent before putting bytes in a permanent bucket.
      await persistOutput(env, id, outputKey);
      await env.PUBLIC_IMAGES.put(outputKey, bytes, {
        httpMetadata: {
          contentType: "image/webp",
          cacheControl: "public, max-age=300, s-maxage=86400",
        },
      });
    } else {
      stats = fileStatistics.parse(await response.json());
      if (
        stats.kind !==
        (metadata.type === "blueprints" ? "blueprint" : "scenario")
      )
        throw new Error("Invalid statistics");
      const source = await env.QUARANTINE.get(job.object_key);
      if (!source) throw new Error("Missing input");
      const digest = createHash("sha256");
      let size = 0;
      const reader = (source.body as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        digest.update(part.value);
      }
      if (size !== job.size || digest.digest("hex") !== job.sha256) {
        await failJob(env, job, "Upload integrity check failed.");
        return;
      }
      const approved = await env.QUARANTINE.get(job.object_key);
      if (!approved) throw new Error("Missing approved input");
      outputKey =
        "releases/" +
        job.item_id +
        "/" +
        id +
        (metadata.type === "blueprints" ? ".cpbp" : ".cpcs");
      await persistOutput(env, id, outputKey);
      await env.FILES.put(outputKey, approved.body, {
        httpMetadata: { contentType: "application/octet-stream" },
      });
    }
    const time = now(),
      statements: D1PreparedStatement[] = [];
    const table = screenshot ? "hub_screenshot" : "hub_release";
    if (screenshot)
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO hub_screenshot(id,image,caption,created_at,item_id) SELECT ?,?,?,?,id FROM hub_item WHERE id=? AND deleted_at IS NULL",
        ).bind(id, outputKey, metadata.caption, time, job.item_id),
      );
    else
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO hub_release(id,version,game_version,changelog,file,original_filename,sha256,size,downloads,created_at,item_id,file_stats) SELECT ?,?,?,?,?,?,?,?,0,?,id,? FROM hub_item WHERE id=? AND deleted_at IS NULL",
        ).bind(
          id,
          metadata.version,
          metadata.game_version,
          metadata.changelog,
          outputKey,
          job.original_filename,
          job.sha256,
          job.size,
          time,
          JSON.stringify(stats),
          job.item_id,
        ),
      );
    statements.push(
      env.DB.prepare(
        `UPDATE hub_uploadjob SET status=CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=?) THEN 'passed' ELSE 'failed' END,completed_at=?,error=CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=?) THEN '' ELSE 'Creation was deleted.' END,${screenshot ? "screenshot_id" : "release_id"}=(SELECT id FROM ${table} WHERE id=?) WHERE id=?`,
      ).bind(id, time, id, id, id),
      env.DB.prepare(
        "UPDATE worker_job SET output_key=?,lease_until=0 WHERE id=?",
      ).bind(outputKey, id),
      env.DB.prepare(
        "UPDATE hub_item SET content_revision=content_revision+1,updated_at=?,review_requested_at=? WHERE id=?",
      ).bind(time, time, job.item_id),
      env.DB.prepare(
        "UPDATE hub_item SET status='published',publish_after_validation=0 WHERE id=? AND publish_after_validation=1 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM hub_uploadjob WHERE item_id=? AND status='pending') AND EXISTS(SELECT 1 FROM hub_release WHERE item_id=?) AND EXISTS(SELECT 1 FROM hub_screenshot WHERE item_id=?)",
      ).bind(job.item_id, job.item_id, job.item_id, job.item_id),
      ...jobCleanupStatements(
        env.DB,
        { object_key: job.object_key, output_key: outputKey },
        time,
      ),
    );
    await env.DB.batch(statements);
    await env.QUARANTINE.delete(job.object_key);
    await run(
      env.DB,
      "DELETE FROM hub_filedeletion WHERE name=? AND bucket='quarantine'",
      job.object_key,
    );
  } catch (error) {
    await run(env.DB, "UPDATE worker_job SET lease_until=0 WHERE id=?", id);
    throw error;
  }
}
