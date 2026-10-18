import type { Table } from "./env";
import { normalizeText, normalizeSearch } from "./text-input";
import { censorText, censorMarkdown } from "./text-filter";
import { fileStatistics } from "./upload-schemas";
import { canRestore, RETENTION_MS } from "./retention";
import {
  Env,
  User,
  Row,
  one,
  all,
  run,
  now,
  uuid,
  publicId,
  dbId,
  HttpError,
  manage,
  staff,
  write,
} from "./env";
export type CatalogItem = Table<"hub_item"> & {
  username: string;
  type_slug: string;
  type_name: string;
  collection_count: number;
};
export type PublicTag = { name: string; item_count: number };
export type SerializedItem = Awaited<ReturnType<typeof serialize>>;
export const METRICS = [
  "width",
  "depth",
  "height",
  "footprint_tiles",
  "objects",
  "object_types",
  "parking_spaces",
  "golf_cart_spaces",
  "entrances",
  "exits",
  "maps",
  "entities",
  "format_version",
];
export const NUMERIC_FILTERS = [...METRICS, "collection_count"];
const COLLECTION_COUNT =
  "(SELECT COUNT(*) FROM hub_bookmark b WHERE b.item_id=i.id)";
const CATALOG_SORTS: Record<string, string> = {
  popular: "i.downloads",
  saved: "collection_count",
  newest: "i.created_at",
  updated: "i.updated_at",
};
export function catalogSort(value: string | null) {
  return value && Object.hasOwn(CATALOG_SORTS, value) ? value : "popular";
}
export const PUBLIC =
  "i.status='published' AND i.is_hidden=0 AND i.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM hub_usermoderation m WHERE m.user_id=i.author_id AND m.shadow_banned_at IS NOT NULL)";
export const SELECT = `SELECT i.*,u.username,t.slug type_slug,t.name type_name,${COLLECTION_COUNT} collection_count FROM hub_item i JOIN auth_user u ON u.id=i.author_id JOIN hub_contenttype t ON t.id=i.content_type_id`;
export function editable(
  item: Pick<Table<"hub_item">, "author_id">,
  u: User | null,
) {
  return !!u && (item.author_id === u.id || manage(u));
}
export async function getItem(
  env: Env,
  id: string,
  u: User | null,
  edit = false,
) {
  const i = await one<CatalogItem>(env.DB, SELECT + " WHERE i.id=?", dbId(id));
  if (!i) throw new HttpError(404, "Creation not found.");
  const shadow = await one(
    env.DB,
    "SELECT 1 FROM hub_usermoderation WHERE user_id=? AND shadow_banned_at IS NOT NULL",
    i.author_id,
  );
  if (
    !staff(u) &&
    u?.id !== i.author_id &&
    (i.deleted_at || shadow || (i.status !== "published" && !i.is_hidden))
  )
    throw new HttpError(404, "Creation not found.");
  if (edit) {
    write(u);
    if (!editable(i, u))
      throw new HttpError(403, "Only the author can edit this creation.");
  } else if (i.is_hidden && !staff(u))
    throw new HttpError(
      403,
      "This creation is hidden. " + censorText(i.hidden_reason),
    );
  return i;
}
export async function publicTags(env: Env, q = "") {
  return all<PublicTag>(
    env.DB,
    `SELECT t.name,COUNT(DISTINCT i.id) item_count FROM hub_tag t LEFT JOIN hub_item_tag_index it ON it.tag_id=t.id LEFT JOIN hub_item i ON i.id=it.item_id AND ${PUBLIC} AND i.is_demo=0 WHERE t.name LIKE ? GROUP BY t.id HAVING t.category_group<>'' OR COUNT(DISTINCT i.id) >= COALESCE((SELECT minimum_items FROM hub_tagsettings WHERE id=1),11) ORDER BY (t.category_group<>'') DESC,item_count DESC,t.name LIMIT 200`,
    "%" + normalizeText(q).trim().slice(0, 200).toLowerCase() + "%",
  );
}
export async function categoryTagGroups(env: Env) {
  const tags = await all<Pick<Table<"hub_tag">, "name" | "category_group">>(
    env.DB,
    "SELECT name,category_group FROM hub_tag WHERE category_group<>'' ORDER BY name",
  );
  return [
    { key: "blueprints", title: "Blueprints", type: "blueprints" },
    { key: "scenarios", title: "Scenarios", type: "scenarios" },
    { key: "themes", title: "Themes & materials", type: "" },
  ].map((group) => ({
    ...group,
    tags: tags.filter((tag) => tag.category_group === group.key),
  }));
}
export async function serialize(
  env: Env,
  i: CatalogItem,
  u: User | null,
  loaded?: {
    releases: Table<"hub_release">[];
    screenshots: Table<"hub_screenshot">[];
    tags: PublicTag[];
  },
) {
  const [releases, screenshots, tags] = loaded
    ? [loaded.releases, loaded.screenshots, loaded.tags]
    : await Promise.all([
        all<Table<"hub_release">>(
          env.DB,
          "SELECT * FROM hub_release WHERE item_id=? ORDER BY created_at DESC,id DESC",
          i.id,
        ),
        all<Table<"hub_screenshot">>(
          env.DB,
          "SELECT * FROM hub_screenshot WHERE item_id=? ORDER BY created_at,id",
          i.id,
        ),
        publicTags(env),
      ]);
  const id = publicId(i.id);
  const base = env.PUBLIC_URL + "/api/v1/items/" + id;
  return {
    id,
    title: censorText(i.title),
    summary: censorText(i.summary),
    description: censorMarkdown(i.description),
    content_type: i.type_slug,
    author: censorText(i.username),
    tags: censorText(
      editable(i, u)
        ? i.tags
        : i.tags
            .split(",")
            .map((x: string) => x.trim())
            .filter((x: string) => tags.some((t) => t.name === x))
            .join(", "),
    ),
    status: i.status,
    publish_after_validation: !!i.publish_after_validation,
    is_demo: !!i.is_demo,
    is_hidden: !!i.is_hidden,
    hidden_reason: censorText(i.hidden_reason),
    deleted_at: i.deleted_at,
    featured_at: i.featured_at,
    downloads: i.downloads,
    collection_count: i.collection_count,
    created_at: i.created_at,
    updated_at: i.updated_at,
    releases: releases.map((r) => ({
      id: publicId(r.id),
      version: censorText(r.version),
      game_version: censorText(r.game_version),
      changelog: censorMarkdown(r.changelog),
      original_filename: censorText(r.original_filename),
      sha256: r.sha256,
      size: r.size,
      downloads: r.downloads,
      created_at: r.created_at,
      file_stats: fileStatistics.partial().parse(JSON.parse(r.file_stats)),
      download_url: base + "/releases/" + publicId(r.id) + "/download/",
    })),
    screenshots: screenshots.map((s) => ({
      id: publicId(s.id),
      caption: censorText(s.caption),
      created_at: s.created_at,
      image_url:
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-[a-f0-9]{16}\.webp$/.test(
          s.image,
        )
          ? env.SCREENSHOT_URL + "/" + s.image
          : base + "/screenshots/" + publicId(s.id) + "/image/",
    })),
  };
}
export async function listItems(
  env: Env,
  p: URLSearchParams,
  u: User | null,
  privateAuthor?: number,
) {
  p = normalizeSearch(p);
  const args: unknown[] = [];
  const filters: string[] = [];
  const mine = p.get("mine") === "true" || p.get("view") === "mine";
  if (privateAuthor && (staff(u) || u?.id === privateAuthor)) {
    filters.push("i.author_id=?");
    args.push(privateAuthor);
  } else if (mine) {
    filters.push("i.author_id=?");
    args.push(u?.id || -1);
  } else {
    filters.push(
      `((${PUBLIC}) OR (i.author_id=? AND i.is_hidden=0 AND i.deleted_at IS NULL))`,
    );
    args.push(u?.id || -1);
  }
  if (p.get("view") === "saved") {
    filters.push(
      "EXISTS(SELECT 1 FROM hub_bookmark b WHERE b.item_id=i.id AND b.user_id=?)",
    );
    args.push(u?.id || -1);
  }
  if (p.get("author")) {
    filters.push("i.author_id=?");
    args.push(Number(p.get("author")) || -1);
  }
  if (p.get("type")) {
    filters.push("t.slug=?");
    args.push(p.get("type"));
  }
  const q = p.get("q")?.trim().slice(0, 200);
  if (q) {
    const matching = mine
      ? null
      : (await publicTags(env, q)).map((t) => t.name);
    filters.push(
      "(i.title LIKE ? OR i.description LIKE ? OR EXISTS(SELECT 1 FROM hub_item_tag_index qi JOIN hub_tag qt ON qt.id=qi.tag_id WHERE qi.item_id=i.id AND " +
        (matching === null
          ? "qt.name LIKE ?"
          : matching.length
            ? "qt.name IN (" + matching.map(() => "?").join(",") + ")"
            : "0") +
        "))",
    );
    args.push(
      "%" + q + "%",
      "%" + q + "%",
      ...(matching === null ? ["%" + q.toLowerCase() + "%"] : matching),
    );
  }
  if (p.get("tag")) {
    const tag = p.get("tag")!.trim().toLowerCase().replace(/\s+/g, " ");
    if (tag.includes("♥")) {
      const candidates = mine
        ? await all<Pick<Table<"hub_tag">, "name">>(
            env.DB,
            "SELECT DISTINCT t.name FROM hub_tag t JOIN hub_item_tag_index ti ON ti.tag_id=t.id JOIN hub_item i ON i.id=ti.item_id WHERE i.author_id=?",
            u?.id || -1,
          )
        : await publicTags(env);
      const matches = candidates.filter((t) => censorText(t.name) === tag);
      filters.push(
        matches.length
          ? "EXISTS(SELECT 1 FROM hub_item_tag_index ti JOIN hub_tag tag ON tag.id=ti.tag_id WHERE ti.item_id=i.id AND tag.name IN (SELECT value FROM json_each(?)))"
          : "0",
      );
      if (matches.length) args.push(JSON.stringify(matches.map((t) => t.name)));
    } else if (!mine && !(await publicTags(env)).some((t) => t.name === tag))
      filters.push("0");
    else {
      filters.push(
        "EXISTS(SELECT 1 FROM hub_item_tag_index ti JOIN hub_tag tag ON tag.id=ti.tag_id WHERE ti.item_id=i.id AND tag.name=?)",
      );
      args.push(tag);
    }
  }
  for (const name of NUMERIC_FILTERS)
    for (const bound of ["min", "max"]) {
      const value = p.get(bound + "_" + name);
      if (value !== null && value !== "") {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 0)
          throw new HttpError(
            400,
            name === "collection_count"
              ? "Invalid collection count filter."
              : "Invalid file statistics filter.",
          );
        const expression =
          name === "collection_count"
            ? COLLECTION_COUNT
            : `json_extract((SELECT r.file_stats FROM hub_release r WHERE r.item_id=i.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1),'$.${name}')`;
        filters.push(`${expression} ${bound === "min" ? ">=" : "<="} ?`);
        args.push(n);
      }
    }
  const where = " WHERE " + filters.join(" AND "),
    sort = CATALOG_SORTS[catalogSort(p.get("sort"))];
  const count = (await one<{ n: number }>(
    env.DB,
    "SELECT COUNT(*) n FROM hub_item i JOIN hub_contenttype t ON t.id=i.content_type_id" +
      where,
    ...args,
  ))!.n;
  const page = Math.max(
      1,
      Math.min(1000000, Math.floor(Number(p.get("page")) || 1)),
    ),
    limit = 24;
  const items = await all<CatalogItem>(
    env.DB,
    SELECT + where + ` ORDER BY ${sort} DESC,i.id LIMIT ? OFFSET ?`,
    ...args,
    limit,
    (page - 1) * limit,
  );
  return { count, page, items, pages: Math.max(1, Math.ceil(count / limit)) };
}
function field(d: Row, k: string, max: number, required = false) {
  const raw = d[k];
  if (raw !== undefined && raw !== null && typeof raw !== "string")
    throw new HttpError(400, `${k} must be text.`);
  const s = normalizeText(raw ?? "").trim();
  if (s.length > max || (required && !s))
    throw new HttpError(
      400,
      `${k} must contain ${required ? "1–" : "at most "}${max} characters.`,
    );
  return s;
}
export async function saveItem(
  env: Env,
  u: User,
  d: Row,
  existing?: CatalogItem,
) {
  write(u);
  if (existing && !editable(existing, u))
    throw new HttpError(403, "Not allowed.");
  const next = { ...existing, ...d };
  const title = field(next, "title", 100, true),
    summary = field(next, "summary", 180, true),
    description = field(next, "description", 20000, true),
    tags = [
      ...new Set(
        field(next, "tags", 200)
          .split(",")
          .map((t) => t.toLowerCase().replace(/\s+/g, " ").trim())
          .filter(Boolean),
      ),
    ].join(", ");
  const type = await one<Table<"hub_contenttype">>(
    env.DB,
    "SELECT * FROM hub_contenttype WHERE (slug=? OR id=?) AND uploads_enabled=1",
    String(d.content_type ?? existing?.type_slug ?? ""),
    Number(d.content_type) || 0,
  );
  if (!type || !["blueprints", "scenarios"].includes(type.slug))
    throw new HttpError(400, "Choose blueprints or scenarios.");
  const id = existing?.id || uuid();
  if (existing && type.id !== existing.content_type_id) {
    const files = await one<{ n: number }>(
      env.DB,
      "SELECT (SELECT COUNT(*) FROM hub_release WHERE item_id=?) + (SELECT COUNT(*) FROM hub_uploadjob WHERE item_id=? AND status='pending') n",
      id,
      id,
    );
    if (files!.n)
      throw new HttpError(
        400,
        "Cannot change file type while releases or pending checks exist.",
      );
  }
  const desired = d.status ?? existing?.status ?? "draft";
  if (desired !== "draft" && desired !== "published")
    throw new HttpError(400, "Invalid status.");
  let status = "draft",
    publish = 0;
  if (existing && desired === "published") {
    const pending = await one<{ n: number }>(
      env.DB,
      "SELECT COUNT(*) n FROM hub_uploadjob WHERE item_id=? AND status='pending'",
      id,
    );
    if (pending!.n) publish = 1;
    else {
      const ok = await one<{ ok: number }>(
        env.DB,
        "SELECT EXISTS(SELECT 1 FROM hub_release WHERE item_id=?) AND EXISTS(SELECT 1 FROM hub_screenshot WHERE item_id=?) ok",
        id,
        id,
      );
      if (!ok!.ok)
        throw new HttpError(
          400,
          "Publishing requires a validated release and screenshot.",
        );
      status = "published";
    }
  }
  const t = now();
  const statements = [];
  if (existing)
    statements.push(
      env.DB.prepare(
        "UPDATE hub_item SET title=?,summary=?,description=?,tags=?,content_type_id=?,status=?,publish_after_validation=?,updated_at=?,content_revision=content_revision+1,review_requested_at=? WHERE id=?",
      ).bind(
        title,
        summary,
        description,
        tags,
        type.id,
        status,
        publish,
        t,
        t,
        id,
      ),
    );
  else
    statements.push(
      env.DB.prepare(
        `INSERT INTO hub_item(id,title,summary,description,tags,status,is_demo,artwork,downloads,created_at,updated_at,author_id,content_type_id,is_hidden,hidden_reason,hidden_at,hidden_by_id,featured_at,featured_by_id,deleted_at,content_revision,reviewed_revision,review_requested_at,publish_after_validation) VALUES (?,?,?,?,?,'draft',0,0,0,?,?,?,?,0,'',NULL,NULL,NULL,NULL,NULL,1,0,?,0)`,
      ).bind(id, title, summary, description, tags, t, t, u.id, type.id, t),
    );
  statements.push(
    env.DB.prepare(
      "INSERT INTO hub_revision(snapshot,created_at,editor_id,item_id) VALUES (?,?,?,?)",
    ).bind(
      JSON.stringify({
        title,
        summary,
        description,
        tags,
        content_type: type.slug,
        status,
      }),
      t,
      u.id,
      id,
    ),
  );
  statements.push(
    env.DB.prepare("DELETE FROM hub_item_tag_index WHERE item_id=?").bind(id),
  );
  for (const tag of tags.split(", ").filter(Boolean)) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO hub_tag(name) VALUES (?)").bind(
        tag,
      ),
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO hub_item_tag_index(item_id,tag_id) SELECT ?,id FROM hub_tag WHERE name=?",
      ).bind(id, tag),
    );
  }
  await env.DB.batch(statements);
  return getItem(env, id, u, true);
}
export async function selfAction(
  env: Env,
  u: User,
  item: Pick<Table<"hub_item">, "id" | "author_id" | "deleted_at">,
  action: "delete" | "restore" | "unpublish",
) {
  write(u);
  if (u.id !== item.author_id)
    throw new HttpError(403, "Only the author can do this.");
  if (action === "delete")
    await run(
      env.DB,
      "UPDATE hub_item SET deleted_at=?,publish_after_validation=0,featured_at=NULL,featured_by_id=NULL WHERE id=? AND deleted_at IS NULL",
      now(),
      item.id,
    );
  else if (action === "restore") {
    if (!canRestore(item.deleted_at))
      throw new HttpError(400, "Restoration period expired.");
    const restored = await run(
      env.DB,
      "UPDATE hub_item SET deleted_at=NULL WHERE id=? AND julianday(deleted_at)>julianday(?)",
      item.id,
      new Date(Date.now() - RETENTION_MS).toISOString(),
    );
    if (!restored.meta.changes)
      throw new HttpError(400, "Restoration period expired.");
  } else
    await run(
      env.DB,
      "UPDATE hub_item SET status='draft',publish_after_validation=0 WHERE id=?",
      item.id,
    );
}

export async function serializeMany(
  env: Env,
  items: CatalogItem[],
  u: User | null,
) {
  if (!items.length) return [];
  const ids = items.map((i) => i.id),
    marks = ids.map(() => "?").join(",");
  const [releases, screenshots, tags] = await Promise.all([
    all<Table<"hub_release">>(
      env.DB,
      `SELECT * FROM hub_release WHERE item_id IN (${marks}) ORDER BY created_at DESC,id DESC`,
      ...ids,
    ),
    all<Table<"hub_screenshot">>(
      env.DB,
      `SELECT * FROM hub_screenshot WHERE item_id IN (${marks}) ORDER BY created_at,id`,
      ...ids,
    ),
    publicTags(env),
  ]);
  return Promise.all(
    items.map((i) =>
      serialize(env, i, u, {
        releases: releases.filter((r) => r.item_id === i.id),
        screenshots: screenshots.filter((s) => s.item_id === i.id),
        tags,
      }),
    ),
  );
}
