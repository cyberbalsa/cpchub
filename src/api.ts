import type { Context } from "hono";
import { z } from "zod";
import type { Table, User } from "./env";
import { normalizeText, normalizeTextFields } from "./text-input";
import { censorText } from "./text-filter";
import { Hono } from "hono";
import { isUpload } from "./multipart";
import {
  App,
  Env,
  Row,
  one,
  all,
  run,
  now,
  uuid,
  publicId,
  dbId,
  HttpError,
  requireUser,
  write,
  admin,
  hash,
  random,
} from "./env";
import {
  getItem,
  listItems,
  serialize,
  serializeMany,
  saveItem,
  selfAction,
  publicTags,
  editable,
} from "./catalog";
import { submit, jobJSON } from "./uploads";
export const api = new Hono<App>();
api.get("/me/", (c) => {
  const u = c.get("user");
  requireUser(u);
  return c.json({ id: u.id, username: u.username });
});
api.on("GET", ["/types/", "/types/:slug/"], async (c) => {
  const setting = await one<Pick<Table<"hub_uploadsettings">, "max_file_mb">>(
    c.env.DB,
    "SELECT max_file_mb FROM hub_uploadsettings WHERE id=1",
  );
  const types = (
    await all<Table<"hub_contenttype">>(
      c.env.DB,
      "SELECT * FROM hub_contenttype WHERE uploads_enabled=1 ORDER BY position,name",
    )
  ).map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    allowed_extensions: z
      .array(z.string())
      .parse(JSON.parse(t.allowed_extensions)),
    uploads_enabled: true,
    max_upload_bytes: (setting?.max_file_mb || 15) * 1024 * 1024,
  }));
  const slug = c.req.param("slug");
  if (slug) {
    const t = types.find((t) => t.slug === slug);
    if (!t) throw new HttpError(404, "Type not found.");
    return c.json(t);
  }
  return c.json(types);
});
api.get("/tags/", async (c) => {
  const tags = await publicTags(c.env, c.req.query("q"));
  return c.json({
    count: tags.length,
    next: null,
    previous: null,
    results: tags.map((tag) => ({ ...tag, name: censorText(tag.name) })),
  });
});
api.get("/tags/suggest/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  return c.json(
    (
      await all<Pick<Table<"hub_tag">, "name">>(
        c.env.DB,
        `SELECT t.name FROM hub_tag t WHERE t.name LIKE ? AND (t.category_group<>'' OR EXISTS(SELECT 1 FROM hub_item_tag_index ti JOIN hub_item i ON i.id=ti.item_id WHERE ti.tag_id=t.id AND (i.author_id=? OR (i.status='published' AND i.is_hidden=0 AND i.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM hub_usermoderation m WHERE m.user_id=i.author_id AND m.shadow_banned_at IS NOT NULL))))) ORDER BY (t.category_group<>'') DESC,t.name LIMIT 200`,
        "%" +
          normalizeText(c.req.query("q") || "")
            .trim()
            .slice(0, 200)
            .toLowerCase() +
          "%",
        u.id,
      )
    ).map((tag) => ({ name: censorText(tag.name) })),
  );
});
api.get("/items/", async (c) => {
  const p = new URL(c.req.url).searchParams,
    r = await listItems(c.env, p, c.get("user"));
  const link = (n: number) => {
    const u = new URL(c.req.url);
    u.searchParams.set("page", String(n));
    return u.href;
  };
  return c.json({
    count: r.count,
    next: r.page < r.pages ? link(r.page + 1) : null,
    previous: r.page > 1 ? link(r.page - 1) : null,
    results: await serializeMany(c.env, r.items, c.get("user")),
  });
});
api.post("/items/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  const i = await saveItem(c.env, u, await body(c));
  return c.json(await serialize(c.env, i, u), 201);
});
api.get("/items/:id/", async (c) =>
  c.json(
    await serialize(
      c.env,
      await getItem(c.env, c.req.param("id"), c.get("user")),
      c.get("user"),
    ),
  ),
);
api.patch("/items/:id/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  const i = await getItem(c.env, c.req.param("id"), u, true);
  return c.json(
    await serialize(c.env, await saveItem(c.env, u, await body(c), i), u),
  );
});
api.delete("/items/:id/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  await selfAction(
    c.env,
    u,
    await getItem(c.env, c.req.param("id"), u, true),
    "delete",
  );
  return c.body(null, 204);
});
api.post("/items/:id/restore/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  const i = await getItem(c.env, c.req.param("id"), u, true);
  await selfAction(c.env, u, i, "restore");
  return c.json(await serialize(c.env, await getItem(c.env, i.id, u, true), u));
});
api.get("/items/:id/upload-jobs/", async (c) => {
  const i = await getItem(c.env, c.req.param("id"), c.get("user"));
  if (!editable(i, c.get("user")))
    throw new HttpError(
      403,
      "Only the author or managing staff can view this.",
    );
  return c.json(
    (
      await all<Table<"hub_uploadjob">>(
        c.env.DB,
        "SELECT * FROM hub_uploadjob WHERE item_id=? ORDER BY created_at DESC LIMIT 50",
        i.id,
      )
    ).map(jobJSON),
  );
});
api.get("/items/:id/history/", async (c) => {
  const i = await getItem(c.env, c.req.param("id"), c.get("user"));
  if (!editable(i, c.get("user")))
    throw new HttpError(
      403,
      "Only the author or managing staff can view this.",
    );
  return c.json(
    (
      await all<Pick<Table<"hub_revision">, "id" | "snapshot" | "created_at">>(
        c.env.DB,
        "SELECT id,snapshot,created_at FROM hub_revision WHERE item_id=? ORDER BY created_at DESC LIMIT 100",
        i.id,
      )
    ).map((r) => ({
      ...r,
      snapshot: z.record(z.string(), z.unknown()).parse(JSON.parse(r.snapshot)),
    })),
  );
});
for (const [path, kind, field] of [
  ["releases", "release", "file"],
  ["screenshots", "screenshot", "image"],
] as const)
  api.post(`/items/:id/${path}/`, async (c) => {
    const u = c.get("user");
    requireUser(u);
    const i = await getItem(c.env, c.req.param("id")!, u, true),
      d = await body(c);
    if (!isUpload(d[field])) throw new HttpError(400, "Choose a file.");
    return c.json(await submit(c.env, u, i, d[field], kind, d), 202);
  });
api.get("/items/:id/releases/:file/download/", async (c) => deliver(c, false));
api.get("/items/:id/screenshots/:file/image/", async (c) => deliver(c, true));
export async function removeScreenshot(
  env: Env,
  u: User | null,
  item: Pick<Table<"hub_item">, "id" | "author_id">,
  id: string,
) {
  write(u);
  if (u.id !== item.author_id && !admin(u))
    throw new HttpError(403, "Not allowed.");
  const shot = await one<Table<"hub_screenshot">>(
    env.DB,
    "SELECT * FROM hub_screenshot WHERE id=? AND item_id=?",
    dbId(id),
    item.id,
  );
  if (!shot) throw new HttpError(404, "Screenshot not found.");
  const result = await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM hub_screenshot WHERE id=? AND (EXISTS(SELECT 1 FROM hub_item WHERE id=? AND status='draft') OR (SELECT COUNT(*) FROM hub_screenshot WHERE item_id=?)>1)",
    ).bind(shot.id, item.id, item.id),
  ]);
  if (!result[0]?.meta.changes)
    throw new HttpError(400, "Published creations need a screenshot.");
}
api.delete("/items/:id/screenshots/:file/", async (c) => {
  const i = await getItem(c.env, c.req.param("id"), c.get("user"), true);
  await removeScreenshot(c.env, c.get("user"), i, c.req.param("file"));
  return c.body(null, 204);
});
export async function body(c: Context<App>): Promise<Row> {
  const uploaded = c.get("uploadBody");
  if (uploaded) return normalizeTextFields(uploaded);
  if (c.req.header("Content-Type")?.includes("application/json")) {
    let data: unknown;
    try {
      data = await c.req.json();
    } catch {
      throw new HttpError(400, "Invalid JSON body.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new HttpError(400, "Expected a JSON object.");
    return normalizeTextFields(data as Row);
  }
  return normalizeTextFields(await c.req.parseBody());
}
export async function issueKey(env: Env, u: User | null, d: Row) {
  requireUser(u);
  if (
    u.auth === "key" ||
    (u.auth === "oauth" && !u.scopes.includes("keys:write"))
  )
    throw new HttpError(403, "Cannot manage API keys.");
  const scopes: unknown[] = Array.isArray(d.scopes)
    ? d.scopes
    : [d.scopes || "read"];
  if (
    !scopes.length ||
    scopes.some(
      (s) =>
        typeof s !== "string" ||
        !["read", "write"].includes(s) ||
        !u.scopes.includes(s),
    )
  )
    throw new HttpError(400, "Invalid scopes.");
  const days =
    d.days === undefined || d.days === null || d.days === ""
      ? null
      : Number(d.days);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 90))
    throw new HttpError(400, "Expiry must be 1–90 days.");
  const name = String(d.name || "").trim();
  if (!name || name.length > 80)
    throw new HttpError(400, "Name is required (80 characters maximum).");
  const id = uuid(),
    prefix = uuid().slice(0, 12),
    key = "cpc_" + prefix + "_" + random();
  const app = u.client_id
    ? await one<{ id: number }>(
        env.DB,
        "SELECT id FROM oauth2_provider_application WHERE client_id=?",
        u.client_id,
      )
    : null;
  const result = await run(
    env.DB,
    "INSERT INTO hub_apikey(id,name,prefix,digest,scopes,created_at,expires_at,last_used_at,revoked_at,user_id,application_id) SELECT ?,?,?,?,?,?,?,NULL,NULL,?,? WHERE (SELECT COUNT(*) FROM hub_apikey WHERE user_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?))<20",
    id,
    name,
    prefix,
    await hash(key),
    JSON.stringify(scopes),
    now(),
    days ? new Date(Date.now() + days * 86400000).toISOString() : null,
    u.id,
    app?.id || null,
    u.id,
    now(),
  );
  if (!result.meta.changes) throw new HttpError(400, "20 active keys maximum.");
  return {
    ...keyJSON(
      (await one<Table<"hub_apikey">>(
        env.DB,
        "SELECT * FROM hub_apikey WHERE id=?",
        id,
      ))!,
    ),
    key,
  };
}
export function keyJSON(k: Table<"hub_apikey">) {
  return {
    id: publicId(k.id),
    name: k.name,
    prefix: k.prefix,
    scopes: z.array(z.string()).parse(JSON.parse(k.scopes)),
    created_at: k.created_at,
    expires_at: k.expires_at,
    last_used_at: k.last_used_at,
    revoked_at: k.revoked_at,
  };
}
api.get("/keys/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  if (
    u.auth === "key" ||
    (u.auth === "oauth" && !u.scopes.includes("keys:write"))
  )
    throw new HttpError(403, "Cannot manage keys.");
  const keys = await all<Table<"hub_apikey">>(
    c.env.DB,
    "SELECT * FROM hub_apikey WHERE user_id=?" +
      (u.auth === "oauth"
        ? " AND application_id=(SELECT id FROM oauth2_provider_application WHERE client_id=?)"
        : ""),
    ...[u.id, ...(u.auth === "oauth" ? [u.client_id] : [])],
  );
  return c.json({
    count: keys.length,
    next: null,
    previous: null,
    results: keys.map(keyJSON),
  });
});
api.post("/keys/", async (c) =>
  c.json(await issueKey(c.env, c.get("user"), await body(c)), 201),
);
api.delete("/keys/:id/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  if (
    u.auth === "key" ||
    (u.auth === "oauth" && !u.scopes.includes("keys:write"))
  )
    throw new HttpError(403, "Cannot manage keys.");
  await run(
    c.env.DB,
    "UPDATE hub_apikey SET revoked_at=? WHERE id=? AND user_id=?" +
      (u.auth === "oauth"
        ? " AND application_id=(SELECT id FROM oauth2_provider_application WHERE client_id=?)"
        : ""),
    now(),
    dbId(c.req.param("id")),
    u.id,
    ...(u.auth === "oauth" ? [u.client_id] : []),
  );
  return c.body(null, 204);
});
export async function deliver(c: Context<App>, image: boolean) {
  const u = c.get("user"),
    i = await getItem(c.env, c.req.param("id")!, u);
  const f = image
    ? await one<Table<"hub_screenshot">>(
        c.env.DB,
        "SELECT * FROM hub_screenshot WHERE id=? AND item_id=?",
        dbId(c.req.param("file")!),
        i.id,
      )
    : await one<Table<"hub_release">>(
        c.env.DB,
        "SELECT * FROM hub_release WHERE id=? AND item_id=?",
        dbId(c.req.param("file")!),
        i.id,
      );
  if (!f) throw new HttpError(404, "File not found.");
  if (
    "image" in f &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-[a-f0-9]{16}\.webp$/.test(
      f.image,
    )
  )
    return c.redirect(c.env.SCREENSHOT_URL + "/" + f.image);
  const object = await c.env.FILES.get("image" in f ? f.image : f.file);
  if (!object) throw new HttpError(503, "File is temporarily unavailable.");
  const headers = new Headers({
    "Content-Type": image ? "image/webp" : "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Length": String(object.size),
    ETag: object.httpEtag,
  });
  if ("file" in f) {
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(censorText(f.original_filename))}`,
    );
    headers.set("X-Content-SHA256", f.sha256);
    if (c.req.method === "GET")
      await countDownload(
        c.env,
        i.id,
        f.id,
        u?.id,
        c.req.header("CF-Connecting-IP"),
      );
  }
  return new Response(c.req.method === "HEAD" ? null : object.body, {
    headers,
  });
}
async function countDownload(
  env: Env,
  item: string,
  release: string,
  user: number | undefined,
  ip: string | undefined,
) {
  // IPv6 /32 is represented by the first 32 expanded bits; no forwarded headers are trusted.
  let network = ip || "";
  if (network.includes(":")) {
    const parts = network.split("::"),
      left = parts[0] ? parts[0].split(":") : [],
      right = parts[1] ? parts[1].split(":") : [];
    const full =
      parts.length === 2
        ? [
            ...left,
            ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill(
              "0",
            ),
            ...right,
          ]
        : left;
    network =
      full
        .slice(0, 2)
        .map((p) => parseInt(p || "0", 16).toString(16))
        .join(":") + "::/32";
  }
  if (!network && !user) return;
  const expires = new Date(Date.now() + 14 * 86400000).toISOString();
  const statements = [];
  for (const r of [null, release]) {
    const condition = r ? "release_id=?" : "item_id=? AND release_id IS NULL",
      key = r || item;
    const table = r ? "hub_release" : "hub_item";
    statements.push(
      env.DB.prepare(
        `UPDATE ${table} SET downloads=MIN(downloads+1,2147483647) WHERE id=? AND NOT EXISTS(SELECT 1 FROM hub_downloaduser WHERE ${condition} AND user_id=?) AND NOT EXISTS(SELECT 1 FROM hub_downloadip WHERE ${condition} AND network=? AND expires_at>?)`,
      ).bind(key, key, user || -1, key, network, now()),
    );
    if (user)
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO hub_downloaduser(item_id,release_id,user_id) VALUES (?,?,?)",
        ).bind(item, r, user),
      );
    if (network) {
      statements.push(
        env.DB.prepare(
          `DELETE FROM hub_downloadip WHERE ${condition} AND network=?`,
        ).bind(key, network),
      );
      statements.push(
        env.DB.prepare(
          "INSERT INTO hub_downloadip(item_id,release_id,network,expires_at) VALUES (?,?,?,?)",
        ).bind(item, r, network, expires),
      );
    }
  }
  await env.DB.batch(statements);
}
