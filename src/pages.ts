import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { normalizeSearch, normalizeTextFields } from "./text-input";
import { censorText } from "./text-filter";
import type { Table } from "./env";
import type { CatalogItem } from "./catalog";
import { Hono } from "hono";
import { isUpload, type UploadedFile } from "./multipart";
import { getCookie, setCookie } from "hono/cookie";
import {
  App,
  Row,
  one,
  all,
  run,
  now,
  publicId,
  dbId,
  HttpError,
  requireUser,
  staff,
  admin,
} from "./env";
import {
  getItem,
  listItems,
  saveItem,
  selfAction,
  editable,
  PUBLIC,
  SELECT,
  NUMERIC_FILTERS,
  catalogSort,
  categoryTagGroups,
  screenshotURL,
} from "./catalog";
import { cachedCatalogFragment, cachedFragment } from "./cache";
import {
  render,
  viewItem,
  viewItems,
  itemHeader,
  form,
  input,
  area,
  select,
  collection,
  safe,
  esc,
} from "./render";
import { submit, jobJSON } from "./uploads";
import { body, issueKey, keyJSON, removeScreenshot, deliver } from "./api";
export const pages = new Hono<App>();
const paginate = <T>(items: T[], count: number, page = 1, pages = 1) =>
  Object.assign(items, {
    paginator: { count, num_pages: pages },
    number: page,
    has_previous: page > 1,
    has_next: page < pages,
    previous_page_number: page - 1,
    next_page_number: page + 1,
  });
function catalogSearch(params: URLSearchParams) {
  const clear = new URLSearchParams(params);
  for (const name of NUMERIC_FILTERS)
    for (const bound of ["min", "max"]) clear.delete(bound + "_" + name);
  clear.delete("page");
  return {
    catalog_view: params.get("view") || "all",
    category: params.get("type") || "",
    q: params.get("q") || "",
    tag: params.get("tag") || "",
    sort: catalogSort(params.get("sort")),
    clear_stats_url: "/?" + clear,
    stats_form: {
      active: NUMERIC_FILTERS.some(
        (k) => !!params.get("min_" + k) || !!params.get("max_" + k),
      ),
    },
  };
}
function catalogParams(c: Context<App>) {
  const params = new URL(c.req.url).searchParams;
  params.delete("render");
  return normalizeSearch(params);
}
function catalogResults(
  c: Context<App>,
  params: URLSearchParams,
  oob: boolean,
) {
  return cachedCatalogFragment(c, params, oob, async () => {
    const u = c.get("user"),
      r = await listItems(c.env, params, u);
    const [items, tagGroups] = await Promise.all([
      viewItems(c.env, r.items, u),
      oob ? categoryTagGroups(c.env) : Promise.resolve([]),
    ]);
    return render(c, "hub/results.html", {
      ...catalogSearch(params),
      page_obj: paginate(items, r.count, r.page, r.pages),
      tag_groups: tagGroups,
      category_filters_oob: oob,
    });
  });
}
pages.get("/catalog/results/", async (c) => {
  const params = catalogParams(c),
    response = await catalogResults(c, params, true);
  response.headers.set(
    "HX-Push-Url",
    c.req.header("HX-Trigger") === "results" ? "false" : "/?" + params,
  );
  return response;
});
pages.get("/", async (c) => {
  const params = catalogParams(c),
    u = c.get("user");
  if (c.req.header("HX-Request") === "true")
    return catalogResults(c, params, true);
  const [results, types, stats, featured, tagGroups] = await Promise.all([
    c.req.query("render") === "full" ? catalogResults(c, params, false) : null,
    all(
      c.env.DB,
      `SELECT t.*,(SELECT COUNT(*) FROM hub_item i WHERE i.content_type_id=t.id AND ${PUBLIC}) total FROM hub_contenttype t WHERE uploads_enabled=1 ORDER BY position,name`,
    ),
    one(
      c.env.DB,
      `SELECT COUNT(*) items,COALESCE(SUM(downloads),0) downloads,COUNT(DISTINCT author_id) authors FROM hub_item i WHERE ${PUBLIC}`,
    ),
    params.size
      ? Promise.resolve([])
      : all<CatalogItem>(
          c.env.DB,
          SELECT +
            ` WHERE ${PUBLIC} AND i.featured_at IS NOT NULL ORDER BY i.featured_at DESC LIMIT 6`,
        ),
    categoryTagGroups(c.env),
  ]);
  const search = catalogSearch(params);
  const ranges = NUMERIC_FILTERS.map((k) => {
    const label =
      k === "collection_count" ? "Collection saves" : k.replaceAll("_", " ");
    return {
      name: k,
      label,
      minimum: safe(
        `<input class="stats-filter-input" name="min_${k}" type="number" min="0" step="1" aria-label="Minimum ${label}" placeholder="Min" value="${esc(params.get("min_" + k))}">`,
      ),
      maximum: safe(
        `<input class="stats-filter-input" name="max_${k}" type="number" min="0" step="1" aria-label="Maximum ${label}" placeholder="Max" value="${esc(params.get("max_" + k))}">`,
      ),
    };
  });
  c.header("X-Catalog-Cache", results?.headers.get("X-Cache") || "DEFERRED");
  return render(c, "hub/catalog.html", {
    ...search,
    catalog_results: results ? safe(await results.text()) : null,
    catalog_fragment_url: "/catalog/results/?" + params,
    catalog_fallback_url:
      "/?" + new URLSearchParams([...params, ["render", "full"]]),
    types_with_counts: types,
    catalog_types: types,
    tag_groups: tagGroups,
    stats,
    featured_items: await viewItems(c.env, featured, u),
    stats_form: {
      ...search.stats_form,
      ranges: ranges.filter((range) => range.name !== "collection_count"),
      collection_ranges: ranges.filter(
        (range) => range.name === "collection_count",
      ),
    },
    seo: {
      title: "CPC Hub — Car Park Capital community exchange",
      description:
        "Find community blueprints and scenarios for Car Park Capital.",
      canonical: c.env.PUBLIC_URL + "/",
      robots: params.size ? "noindex, follow" : "index, follow",
      image: c.env.PUBLIC_URL + "/static/art/share-card.png",
    },
  });
});
function itemContent(c: Context<App>, id: string, item?: CatalogItem) {
  const url = new URL(`/items/${publicId(dbId(id))}/content/`, c.req.url);
  url.searchParams.set("__fragment", "item-v1");
  return cachedFragment(c, url, async () => {
    const u = c.get("user"),
      i = item || (await getItem(c.env, id, u));
    return render(c, "hub/detail_content.html", {
      item: await viewItem(c.env, i, u),
    });
  });
}
pages.get("/items/:id/content/", (c) => itemContent(c, c.req.param("id")));
pages.get("/items/:id/", async (c) => {
  const u = c.get("user"),
    i = await getItem(c.env, c.req.param("id"), u),
    item = itemHeader(i);
  const [content, screenshot, release] = await Promise.all([
    c.req.query("render") === "full" ? itemContent(c, i.id, i) : null,
    one<Pick<Table<"hub_screenshot">, "id" | "image">>(
      c.env.DB,
      "SELECT id,image FROM hub_screenshot WHERE item_id=? ORDER BY created_at,id LIMIT 1",
      i.id,
    ),
    one(c.env.DB, "SELECT id FROM hub_release WHERE item_id=? LIMIT 1", i.id),
  ]);
  c.header("X-Item-Cache", content?.headers.get("X-Cache") || "DEFERRED");
  return render(c, "hub/detail.html", {
    item,
    detail_content: content ? safe(await content.text()) : null,
    can_edit: editable(i, u),
    saved:
      !!u &&
      !!(await one(
        c.env.DB,
        "SELECT id FROM hub_bookmark WHERE user_id=? AND item_id=?",
        u.id,
        i.id,
      )),
    show_download_warning:
      !!release &&
      getCookie(c, "cpc_warning") !== "1" &&
      (!u ||
        !(await one(
          c.env.DB,
          "SELECT id FROM hub_userpreferences WHERE user_id=? AND ugc_warning_version=1",
          u.id,
        ))),
    download_warning_form: {
      remember: safe(
        '<input type="checkbox" id="remember" name="remember" value="1"><label for="remember">Don’t show this again</label>',
      ),
    },
    seo: {
      title: item.title + " — CPC Hub",
      description: item.summary,
      author: item.author.username,
      canonical: c.env.PUBLIC_URL + item.get_absolute_url,
      robots:
        i.status === "published" && !i.is_hidden && !i.deleted_at
          ? "index, follow"
          : "noindex, nofollow",
      image: screenshot
        ? screenshotURL(c.env, i.id, screenshot)
        : c.env.PUBLIC_URL + "/static/art/share-card.png",
      image_type: "image/webp",
      type: "website",
    },
  });
});
async function editor(c: Context<App>, id?: string) {
  const u = c.get("user");
  requireUser(u);
  let i = id ? await getItem(c.env, id, u, true) : undefined;
  if (c.req.method === "POST") {
    const d = await body(c);
    const action = d.action || "metadata";
    if (action !== "metadata" && !i)
      throw new HttpError(400, "Create the upload before adding files.");
    if (action === "metadata") {
      let uploads:
        | { file: File | UploadedFile; screenshots: (File | UploadedFile)[] }
        | undefined;
      if (!id) {
        if (!isUpload(d.file))
          throw new HttpError(400, "Choose a native game file.");
        const shots = Array.isArray(d.screenshots)
          ? (d.screenshots as unknown[])
          : d.screenshots
            ? [d.screenshots]
            : [];
        if (shots.length < 1 || shots.length > 8 || !shots.every(isUpload))
          throw new HttpError(400, "Choose 1–8 screenshots.");
        uploads = { file: d.file, screenshots: shots };
      }
      i = await saveItem(c.env, u, d, i);
      if (uploads) {
        await submit(c.env, u, i, uploads.file, "release", d);
        for (const file of uploads.screenshots)
          await submit(c.env, u, i, file, "screenshot", {});
        if (d.status === "published")
          await run(
            c.env.DB,
            "UPDATE hub_item SET publish_after_validation=1 WHERE id=?",
            i.id,
          );
      }
    } else if (action === "release") {
      if (!isUpload(d.file)) throw new HttpError(400, "Choose a file.");
      await submit(c.env, u, i!, d.file, "release", d);
    } else if (action === "screenshot") {
      if (!isUpload(d.image)) throw new HttpError(400, "Choose a screenshot.");
      await submit(c.env, u, i!, d.image, "screenshot", d);
    } else if (action === "remove-screenshot")
      await removeScreenshot(c.env, u, i!, String(d.screenshot_id || ""));
    else throw new HttpError(400, "Unknown action.");
    if (c.req.header("Accept")?.includes("application/json"))
      return c.json(
        { redirect_url: "/items/" + publicId(i!.id) + "/edit/" },
        202,
      );
    return c.redirect("/items/" + publicId(i!.id) + "/edit/");
  }
  const types = await all(
    c.env.DB,
    "SELECT slug,name FROM hub_contenttype WHERE uploads_enabled=1 ORDER BY position",
  );
  let item = i ? await viewItem(c.env, i, u) : undefined;
  if (item) {
    item.upload_jobs = collection(
      (
        await all<Table<"hub_uploadjob">>(
          c.env.DB,
          "SELECT * FROM hub_uploadjob WHERE item_id=? ORDER BY created_at DESC LIMIT 12",
          i!.id,
        )
      ).map(jobJSON),
    );
    item.revisions = collection(
      (
        await all<Table<"hub_revision"> & { username: string | null }>(
          c.env.DB,
          "SELECT r.*,u.username FROM hub_revision r LEFT JOIN auth_user u ON u.id=r.editor_id WHERE item_id=? ORDER BY created_at DESC LIMIT 20",
          i!.id,
        )
      ).map((r) => ({
        ...r,
        editor: { pk: r.editor_id, username: r.username },
        snapshot: {
          items: Object.entries(
            z.record(z.string(), z.unknown()).parse(JSON.parse(r.snapshot)),
          ),
        },
      })),
    );
  }
  return render(c, "hub/editor.html", {
    creating: !id,
    item,
    tag_groups: await categoryTagGroups(c.env),
    can_remove_screenshots: !i || u.id === i.author_id || admin(u),
    min_screenshots: 1,
    max_screenshots: 8,
    form: form(
      input("title", "Title", i?.title, "text", 'required maxlength="100"') +
        select(
          "content_type",
          "File type",
          types.map((t) => ({ value: t.slug, label: t.name })),
          i?.type_slug,
        ) +
        input(
          "summary",
          "Short description",
          i?.summary,
          "text",
          'required maxlength="180"',
        ) +
        area("description", "Description", i?.description) +
        input(
          "tags",
          "Tags",
          i?.tags,
          "text",
          'maxlength="200" data-tag-input="/api/v1/tags/suggest/" data-tag-multiple="true"',
        ) +
        select(
          "status",
          "Visibility",
          [
            { value: "draft", label: "Draft (private)" },
            { value: "published", label: "Published" },
          ],
          i?.publish_after_validation ? "published" : i?.status || "published",
        ),
    ),
    release_form: form(
      input("version", "Version", "1.0.0", "text", 'maxlength="40" required') +
        input("game_version", "Game version", "", "text", 'maxlength="40"') +
        input(
          "file",
          "Game file",
          "",
          "file",
          'required accept=".cpbp,.cpcs"',
        ) +
        area("changelog", "Changelog", "", 10000),
    ),
    screenshot_form: form(
      id
        ? input(
            "image",
            "Screenshot",
            "",
            "file",
            'required accept="image/png,image/jpeg,image/webp"',
          ) + input("caption", "Caption", "", "text", 'maxlength="180"')
        : input(
            "screenshots",
            "Screenshots",
            "",
            "file",
            'required multiple accept="image/png,image/jpeg,image/webp"',
          ),
    ),
  });
}
pages.on(["GET", "POST"], "/upload/", (c) => editor(c));
pages.on(["GET", "POST"], "/items/:id/edit/", (c) =>
  editor(c, c.req.param("id")),
);
pages.get("/items/:id/checks/", async (c) => {
  const i = await getItem(c.env, c.req.param("id"), c.get("user"), true);
  const item = await viewItem(c.env, i, c.get("user"));
  item.upload_jobs = collection(
    (
      await all<Table<"hub_uploadjob">>(
        c.env.DB,
        "SELECT * FROM hub_uploadjob WHERE item_id=? ORDER BY created_at DESC LIMIT 12",
        i.id,
      )
    ).map(jobJSON),
  );
  return render(c, "hub/upload_checks.html", { item });
});
pages.post("/items/:id/save/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  const i = await getItem(c.env, c.req.param("id"), u);
  const b = await one(
    c.env.DB,
    "SELECT id FROM hub_bookmark WHERE user_id=? AND item_id=?",
    u.id,
    i.id,
  );
  if (b) await run(c.env.DB, "DELETE FROM hub_bookmark WHERE id=?", b.id);
  else
    await run(
      c.env.DB,
      "INSERT OR IGNORE INTO hub_bookmark(user_id,item_id,created_at) VALUES (?,?,?)",
      u.id,
      i.id,
      now(),
    );
  if (c.req.header("HX-Request")) {
    const count = await one<{ collection_count: number; saved: number }>(
      c.env.DB,
      "SELECT COUNT(*) collection_count,COALESCE(MAX(user_id=?),0) saved FROM hub_bookmark WHERE item_id=?",
      u.id,
      i.id,
    );
    return render(c, "hub/bookmark.html", {
      item: { ...itemHeader(i), collection_count: count!.collection_count },
      saved: !!count!.saved,
    });
  }
  return c.redirect("/items/" + publicId(i.id) + "/");
});
for (const action of ["delete", "restore", "unpublish"] as const)
  pages.on(["GET", "POST"], `/items/:id/${action}/`, async (c) => {
    const u = c.get("user");
    requireUser(u);
    const i = await getItem(c.env, c.req.param("id")!, u, true);
    if (c.req.method === "POST") {
      await selfAction(c.env, u, i, action);
      return c.redirect("/?view=mine");
    }
    return render(c, "hub/self_delete.html", {
      item: await viewItem(c.env, i, u),
    });
  });
pages.on(["GET", "POST"], "/items/:id/releases/:file/download/", async (c) => {
  const u = c.get("user"),
    i = await getItem(c.env, c.req.param("id"), u),
    release = await one<Table<"hub_release">>(
      c.env.DB,
      "SELECT * FROM hub_release WHERE id=? AND item_id=?",
      dbId(c.req.param("file")),
      i.id,
    );
  if (!release) throw new HttpError(404, "File not found.");
  const prefs = u
    ? await one(
        c.env.DB,
        "SELECT * FROM hub_userpreferences WHERE user_id=?",
        u.id,
      )
    : null;
  if (c.req.method === "POST") {
    const d = await body(c);
    if (d.remember || d.skip_warning) {
      setCookie(c, "cpc_warning", "1", {
        httpOnly: true,
        secure: c.env.PUBLIC_URL.startsWith("https:"),
        sameSite: "Lax",
        path: "/",
        maxAge: 365 * 86400,
      });
      if (u)
        await run(
          c.env.DB,
          "INSERT INTO hub_userpreferences(user_id,ugc_warning_version,ugc_warning_acknowledged_at) VALUES (?,1,?) ON CONFLICT(user_id) DO UPDATE SET ugc_warning_version=1,ugc_warning_acknowledged_at=excluded.ugc_warning_acknowledged_at",
          u.id,
          now(),
        );
    }
    if (c.req.header("Accept")?.includes("application/json"))
      return c.json({
        download_url:
          "/api/v1/items/" +
          publicId(i.id) +
          "/releases/" +
          publicId(release.id) +
          "/download/",
        remembered: !!(d.remember || d.skip_warning),
      });
    return c.redirect(
      "/api/v1/items/" +
        publicId(i.id) +
        "/releases/" +
        publicId(release.id) +
        "/download/",
    );
  }
  if (
    getCookie(c, "cpc_warning") === "1" ||
    prefs?.ugc_warning_version === 1 ||
    c.req.method === "HEAD"
  )
    return deliver(c, false);
  return render(c, "hub/download_warning.html", {
    item: await viewItem(c.env, i, u),
    release: {
      ...release,
      original_filename: censorText(release.original_filename),
      pk: publicId(release.id),
    },
    download_warning_url: c.req.path,
    download_warning_form: {
      remember: safe(
        '<input type="checkbox" id="remember" name="remember" value="1"><label for="remember">Don’t show this again</label>',
      ),
    },
  });
});
pages.get("/creators/:id/", async (c) => {
  const author = await one<
    Pick<Table<"auth_user">, "id" | "username" | "date_joined">
  >(
    c.env.DB,
    "SELECT id,username,date_joined FROM auth_user WHERE id=? AND is_active=1",
    Number(c.req.param("id")),
  );
  if (!author) throw new HttpError(404, "Creator not found.");
  const p = new URL(c.req.url).searchParams;
  p.set("author", String(author.id));
  const u = c.get("user"),
    showPrivate = staff(u) || u?.id === author.id;
  const r = await listItems(c.env, p, u, showPrivate ? author.id : undefined);
  return render(c, "hub/creator_profile.html", {
    creator: {
      ...author,
      username: censorText(author.username),
      pk: author.id,
    },
    owns_profile: u?.id === author.id,
    show_private: showPrivate,
    seo: {
      title: censorText(author.username) + " — CPC Hub",
      description: "Creations by " + censorText(author.username),
      canonical: c.env.PUBLIC_URL + "/creators/" + author.id + "/",
      robots: showPrivate ? "noindex, nofollow" : "index, follow",
    },
    page_obj: paginate(
      await viewItems(c.env, r.items, c.get("user")),
      r.count,
      r.page,
      r.pages,
    ),
    stats: { items: r.count },
  });
});
pages.get("/accounts/3rdparty/", (c) => c.redirect("/account/profile/"));
pages.get("/accounts/login/", (c) =>
  render(c, "account/login.html", {
    steam_enabled: true,
    discord_enabled: !!c.env.DISCORD_CLIENT_ID,
  }),
);
pages.get("/accounts/logout/", (c) => render(c, "account/logout.html"));
pages.on(["GET", "POST"], "/account/keys/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  let newKey;
  if (c.req.method === "POST")
    newKey = (
      await issueKey(
        c.env,
        u,
        normalizeTextFields(await c.req.parseBody({ all: true })),
      )
    ).key;
  const keys = (
    await all<Table<"hub_apikey">>(
      c.env.DB,
      "SELECT * FROM hub_apikey WHERE user_id=? ORDER BY created_at DESC",
      u.id,
    )
  ).map((k) => ({
    ...keyJSON(k),
    pk: publicId(k.id),
    active:
      !k.revoked_at && (!k.expires_at || Date.parse(k.expires_at) > Date.now()),
  }));
  const apps = await all(
    c.env.DB,
    "SELECT DISTINCT a.id pk,a.name FROM oauth2_provider_application a JOIN worker_token t ON t.client_id=a.client_id WHERE t.user_id=?",
    u.id,
  );
  return render(c, "hub/keys.html", {
    keys,
    connected_apps: apps,
    new_key: newKey,
    form: form(
      input("name", "Name", "", "text", 'required maxlength="80"') +
        '<p><label><input type="checkbox" name="scopes" value="read" checked> Read</label><label><input type="checkbox" name="scopes" value="write"> Write</label></p>' +
        select(
          "days",
          "Expiry",
          [
            { value: "", label: "Never" },
            { value: 7, label: "7 days" },
            { value: 30, label: "30 days" },
            { value: 90, label: "90 days" },
          ],
          "",
        ),
    ),
  });
});
pages.post("/account/keys/:id/revoke/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  await run(
    c.env.DB,
    "UPDATE hub_apikey SET revoked_at=? WHERE id=? AND user_id=?",
    now(),
    dbId(c.req.param("id")),
    u.id,
  );
  return c.redirect("/account/keys/");
});
pages.post("/account/managers/:id/revoke/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM worker_token WHERE user_id=? AND client_id=(SELECT client_id FROM oauth2_provider_application WHERE id=?)",
    ).bind(u.id, Number(c.req.param("id"))),
    c.env.DB.prepare(
      "UPDATE hub_apikey SET revoked_at=? WHERE user_id=? AND application_id=?",
    ).bind(now(), u.id, Number(c.req.param("id"))),
  ]);
  return c.redirect("/account/keys/");
});
const NAME_CHANGE_INTERVAL = 30 * 86400000;
pages.on(["GET", "POST"], "/account/profile/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  let name = u.username,
    nameError = "",
    status: ContentfulStatusCode = 200;
  if (c.req.method === "POST") {
    const d = await body(c);
    if (d.action === "rename") {
      name =
        typeof d.username === "string"
          ? d.username.trim().normalize("NFC")
          : "";
      if (!name) nameError = "Enter a name.";
      else if (name.length > 150) nameError = "Use 150 characters or fewer.";
      else if (!/^[\p{L}\p{M}\p{N}_ .-]+$/u.test(name))
        nameError =
          "Use letters, numbers, spaces, periods, hyphens, or underscores.";
      else if (name === u.username)
        return c.redirect("/account/profile/#profile-name", 303);
      else {
        const at = Date.now();
        // Check availability and cooldown in the same write so concurrent requests cannot bypass either.
        const changed = await c.env.DB.prepare(
          `UPDATE auth_user SET username=?1,username_changed_at=?2
     WHERE id=?3 AND is_active=1 AND username<>?1
      AND (username_changed_at IS NULL OR username_changed_at<=?4)
      AND NOT EXISTS(SELECT 1 FROM auth_user WHERE username=?1 AND id<>?3)
     RETURNING id`,
        )
          .bind(name, at, u.id, at - NAME_CHANGE_INTERVAL)
          .first<Row>();
        if (changed)
          return c.redirect(
            "/account/profile/?name_changed=1#profile-name",
            303,
          );
        const current = await one<
          Pick<Table<"auth_user">, "username" | "username_changed_at">
        >(
          c.env.DB,
          "SELECT username,username_changed_at FROM auth_user WHERE id=? AND is_active=1",
          u.id,
        );
        if (!current) throw new HttpError(403, "This account is inactive.");
        Object.assign(u, current);
        if (name === u.username)
          return c.redirect("/account/profile/#profile-name", 303);
        nameError =
          u.username_changed_at !== null &&
          u.username_changed_at + NAME_CHANGE_INTERVAL > at
            ? "You can change your name once every 30 days."
            : "That name is taken.";
        status = 409;
      }
      if (nameError && status === 200) status = 400;
    } else if (d.action === "unlink" || (!d.action && d.account)) {
      await run(
        c.env.DB,
        `DELETE FROM socialaccount_socialaccount WHERE id=?1 AND user_id=?2
    AND (SELECT COUNT(*) FROM socialaccount_socialaccount WHERE user_id=?2)+(SELECT COUNT(*) FROM worker_passkey WHERE user_id=?2)>1`,
        Number(d.account),
        u.id,
      );
      return c.redirect("/account/profile/");
    } else if (d.action === "remove-passkey") {
      const removed = await run(
        c.env.DB,
        `DELETE FROM worker_passkey WHERE id=?1 AND user_id=?2
    AND (SELECT COUNT(*) FROM worker_passkey WHERE user_id=?2)+(SELECT COUNT(*) FROM socialaccount_socialaccount WHERE user_id=?2)>1`,
        String(d.passkey || ""),
        u.id,
      );
      if (!removed.meta.changes)
        throw new HttpError(
          409,
          "Keep at least one sign-in method on your account.",
        );
      return c.redirect("/account/profile/#passkeys", 303);
    } else throw new HttpError(400, "Unknown action.");
  }
  const availableAt =
    u.username_changed_at == null
      ? null
      : u.username_changed_at + NAME_CHANGE_INTERVAL;
  const canChangeName = availableAt === null || availableAt <= Date.now();
  const accounts = await all(
    c.env.DB,
    "SELECT id,provider,uid name FROM socialaccount_socialaccount WHERE user_id=?",
    u.id,
  );
  const keys = await all(
    c.env.DB,
    "SELECT id,created_at,last_used_at FROM worker_passkey WHERE user_id=? ORDER BY created_at,id",
    u.id,
  );
  return render(
    c,
    "hub/profile.html",
    {
      profile_name: canChangeName ? name : u.username,
      name_error: nameError,
      name_changed: c.req.query("name_changed") === "1",
      can_change_name: canChangeName,
      name_change_available_at:
        availableAt === null ? null : new Date(availableAt).toISOString(),
      hidden_creations: (
        await all<Pick<Table<"hub_item">, "id" | "title" | "hidden_reason">>(
          c.env.DB,
          "SELECT id,title,hidden_reason FROM hub_item WHERE author_id=? AND is_hidden=1 AND deleted_at IS NULL",
          u.id,
        )
      ).map((i) => ({ ...i, pk: publicId(i.id) })),
      linked_accounts: accounts,
      passkeys: keys,
      passkey_added: c.req.query("passkey_added") === "1",
      can_disconnect: accounts.length + keys.length > 1,
      steam_enabled: true,
      discord_enabled: !!c.env.DISCORD_CLIENT_ID,
      site_role: u.role,
      download_warning_acknowledged: !!(await one(
        c.env.DB,
        "SELECT id FROM hub_userpreferences WHERE user_id=? AND ugc_warning_version=1",
        u.id,
      )),
    },
    status,
  );
});
pages.post("/account/download-warning/reset/", async (c) => {
  const u = c.get("user");
  requireUser(u);
  await run(
    c.env.DB,
    "UPDATE hub_userpreferences SET ugc_warning_version=0 WHERE user_id=?",
    u.id,
  );
  setCookie(c, "cpc_warning", "0", { path: "/", httpOnly: true });
  return c.redirect("/account/profile/");
});
pages.get("/install/", (c) => render(c, "hub/install.html"));
pages.get("/developers/", (c) =>
  render(c, "hub/developers.html", { api_base: c.env.PUBLIC_URL + "/api/v1/" }),
);
pages.get("/donate/", (c) => render(c, "hub/donate.html"));
pages.get("/out/", async (c) => {
  let destination;
  try {
    destination = new URL(c.req.query("url") || "");
  } catch {
    throw new HttpError(400, "Invalid destination.");
  }
  if (
    !["https:", "http:"].includes(destination.protocol) ||
    destination.username ||
    destination.password
  )
    throw new HttpError(400, "Invalid destination.");
  return render(c, "hub/outbound.html", {
    destination: destination.href,
    destination_host: destination.host,
  });
});

pages.get("/admin/login/", (c) => c.redirect("/accounts/login/"));
