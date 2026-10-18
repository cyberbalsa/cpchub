import type { Context } from "hono";
import type { App, Table } from "./env";
import type { CatalogItem, SerializedItem } from "./catalog";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { jobJSON } from "./uploads";
import { canRestore, RETENTION_MS } from "./retention";
import { censorText, censorHTML } from "./text-filter";
// Templates are compiled at build time; the Worker never evaluates template source.
import nunjucks from "nunjucks/browser/nunjucks-slim.js";
import compiled from "./templates.generated.js";
import { marked } from "marked";
import { readEstimate } from "./cost-estimates";
import sanitize from "sanitize-html";
import { getCookie, setCookie } from "hono/cookie";
import {
  Env,
  Row,
  User,
  one,
  random,
  staff,
  manage,
  admin,
  publicId,
} from "./env";
import { serialize, serializeMany, PUBLIC } from "./catalog";
export const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const routes: Record<string, string> = {
  "admin:index": "/admin/",
  "item-upload-checks": "/items/{}/checks/",
  catalog: "/",
  install: "/install/",
  keys: "/account/keys/",
  profile: "/account/profile/",
  developers: "/developers/",
  donate: "/donate/",
  moderation: "/moderation/",
  "item-create": "/upload/",
  account_login: "/accounts/login/",
  account_logout: "/accounts/logout/",
  "outbound-link": "/out/",
  "creator-profile": "/creators/{}/",
  "item-detail": "/items/{}/",
  "item-edit": "/items/{}/edit/",
  "item-download": "/items/{}/releases/{}/download/",
  "item-self-delete": "/items/{}/delete/",
  "item-self-restore": "/items/{}/restore/",
  "item-unpublish": "/items/{}/unpublish/",
  bookmark: "/items/{}/save/",
  "upload-checks": "/items/{}/checks/",
  "key-revoke": "/account/keys/{}/revoke/",
  "manager-revoke": "/account/managers/{}/revoke/",
  "download-warning-reset": "/account/download-warning/reset/",
  "api-tag-list": "/api/v1/tags/",
  "api-tag-suggest": "/api/v1/tags/suggest/",
  "api-item-screenshot-image": "/api/v1/items/{}/screenshots/{}/image/",
  "moderation-item": "/moderation/items/{}/",
  "moderation-delete": "/moderation/items/{}/delete/",
  "moderation-users": "/moderation/users/",
  "moderation-user": "/moderation/users/{}/",
  "moderation-user-delete": "/moderation/users/{}/delete/",
  "moderation-review-queue": "/moderation/reviews/",
  "moderation-account-activity": "/moderation/activity/",
  "moderation-tag-settings": "/moderation/tags/",
  "moderation-upload-settings": "/moderation/uploads/",
  "moderation-release-edit": "/moderation/items/{}/releases/{}/edit/",
  "moderation-release-delete": "/moderation/items/{}/releases/{}/delete/",
  "moderation-screenshot-edit": "/moderation/items/{}/screenshots/{}/edit/",
  "moderation-screenshot-delete": "/moderation/items/{}/screenshots/{}/delete/",
  authorize: "/o/authorize/",
  schema: "/api/schema/",
  "swagger-ui": "/api/docs/",
  redoc: "/api/redoc/",
};
export function url(name: string, ...args: unknown[]) {
  let p = routes[name];
  if (!p) throw Error("Unknown route " + name);
  for (const arg of args) p = p.replace("{}", encodeURIComponent(String(arg)));
  return p;
}
export const safe = (s: string) => new nunjucks.runtime.SafeString(s);
export const environment = new nunjucks.Environment(
  new nunjucks.PrecompiledLoader(compiled),
  { autoescape: true },
);
environment.addGlobal("url", url);
environment.addFilter("censor", censorText);
environment.addGlobal("static_url", (p: string) => "/static/" + p);
environment.addGlobal(
  "provider_login_url",
  (p: string) => "/accounts/" + p + "/login/",
);
environment.addFilter("pluralize", (v: unknown, arg: string = "s") => {
  const a = arg.split(",");
  return Number(v) === 1 ? (a.length === 2 ? a[0] : "") : a.at(-1);
});
environment.addFilter("filesizeformat", (v: number) =>
  v >= 1048576
    ? (v / 1048576).toFixed(1) + " MB"
    : v >= 1024
      ? (v / 1024).toFixed(1) + " KB"
      : (v || 0) + " bytes",
);
environment.addFilter("slice", (a: unknown, range: string) => {
  const [start, end] = range.split(":");
  return typeof a === "string" || Array.isArray(a)
    ? (a as string | unknown[]).slice(
        Number(start) || 0,
        end ? Number(end) : undefined,
      )
    : [];
});
environment.addFilter("date", (v: string, format: string = "M j, Y") => {
  if (!v) return "";
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0"),
    months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
  const parts: Row = {
    Y: d.getUTCFullYear(),
    y: pad(d.getUTCFullYear() % 100),
    m: pad(d.getUTCMonth() + 1),
    n: d.getUTCMonth() + 1,
    d: pad(d.getUTCDate()),
    j: d.getUTCDate(),
    F: months[d.getUTCMonth()],
    M: months[d.getUTCMonth()]!.slice(0, 3),
    H: pad(d.getUTCHours()),
    i: pad(d.getUTCMinutes()),
    s: pad(d.getUTCSeconds()),
  };
  return [...format].map((x) => parts[x] ?? x).join("");
});
environment.addFilter("floatformat", (v: unknown, d: number = 2) =>
  Number(v || 0).toFixed(Number(d)),
);
environment.addFilter("default", (v: unknown, d: unknown) => v || d);
environment.addFilter("default_if_none", (v: unknown, d: unknown) => v ?? d);
environment.addFilter(
  "yesno",
  (v: unknown, a: string) => a.split(",")[v ? 0 : 1],
);
environment.addFilter("linebreaksbr", (v: unknown) =>
  safe(esc(v).replace(/\n/g, "<br>")),
);
environment.addFilter("linebreaks", (v: unknown) =>
  safe(
    "<p>" + esc(v).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>") + "</p>",
  ),
);
environment.addFilter(
  "outbound_url",
  (v: string) => "/out/?url=" + encodeURIComponent(v),
);
const markdownPolicy: sanitize.IOptions = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "em",
    "del",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "h2",
    "h3",
    "h4",
    "a",
    "hr",
  ],
  allowedAttributes: { a: ["href", "rel"] },
  allowedSchemes: ["https", "http"],
};
environment.addFilter("basic_markdown", (v: string) =>
  safe(
    censorHTML(
      sanitize(marked.parse(v || "", { async: false }) as string, {
        ...markdownPolicy,
        transformTags: {
          a: (_tag, a) => ({
            tagName: "a",
            attribs: {
              href: "/out/?url=" + encodeURIComponent(a.href || ""),
              rel: "nofollow ugc noopener",
            },
          }),
        },
      }),
    ),
  ),
);
export function collection<T>(a: T[]) {
  return Object.assign(a, {
    all: a,
    first: a[0],
    count: a.length,
    exists: !!a.length,
  });
}
export function itemHeader(i: CatalogItem) {
  const id = publicId(i.id);
  return {
    pk: id,
    title: censorText(i.title),
    summary: censorText(i.summary),
    hidden_reason: censorText(i.hidden_reason),
    author: {
      id: i.author_id,
      pk: i.author_id,
      username: censorText(i.username),
    },
    content_type: { name: i.type_name, slug: i.type_slug },
    get_absolute_url: "/items/" + id + "/",
    status: i.status,
    is_demo: !!i.is_demo,
    is_hidden: !!i.is_hidden,
    deleted_at: i.deleted_at,
    updated_at: i.updated_at,
    collection_count: i.collection_count,
    can_restore: canRestore(i.deleted_at),
    delete_after: i.deleted_at
      ? new Date(Date.parse(i.deleted_at) + RETENTION_MS).toISOString()
      : null,
  };
}
export async function viewItem(
  env: Env,
  i: CatalogItem,
  u: User | null,
  serialized?: SerializedItem,
) {
  const s = serialized || (await serialize(env, i, u));
  const releases = collection(
    s.releases.map((r) => ({
      ...r,
      pk: r.id,
      stat_rows: Object.entries(r.file_stats)
        .filter(([k]) => !["schema_version", "kind"].includes(k))
        .map(([k, v]) => ({
          label: k.replaceAll("_", " "),
          value: v ?? "Unavailable",
          unit: "",
        })),
    })),
  );
  const screenshots = collection(
    s.screenshots.map((s) => ({ ...s, pk: s.id })),
  );
  return {
    ...i,
    ...s,
    ...itemHeader(i),
    upload_jobs: undefined as
      ReturnType<typeof collection<ReturnType<typeof jobJSON>>> | undefined,
    revisions: undefined as
      | ReturnType<
          typeof collection<{
            id: number;
            snapshot: { items: [string, unknown][] };
            editor: { pk: number | null; username: string | null };
            created_at: string;
          }>
        >
      | undefined,
    get_status_display: i.status === "published" ? "Published" : "Draft",
    artwork_path: "art/lot-" + i.artwork + ".svg",
    public_tag_list: s.tags.split(", ").filter(Boolean),
    releases,
    screenshots,
    latest_release: releases[0],
    needs_review: i.content_revision > i.reviewed_revision,
  };
}
export async function render(
  c: Context<App>,
  template: string,
  data: Row & {
    item?:
      | (ReturnType<typeof itemHeader> & {
          upload_jobs?: Awaited<ReturnType<typeof viewItem>>["upload_jobs"];
        })
      | undefined;
  } = {},
  status: ContentfulStatusCode = 200,
) {
  const u = c.get("user");
  const fragment = [
    "hub/results.html",
    "hub/detail_content.html",
    "hub/bookmark.html",
  ].includes(template);
  // Shared anonymous pages contain no browser-specific tokens or cookies.
  // Download dialogs obtain their token only when the visitor confirms.
  const cachedPage = ["hub/catalog.html", "hub/detail.html"].includes(template);
  const csrf = fragment || cachedPage ? u?.csrf : csrfToken(c);
  const totals = fragment
    ? null
    : await one(
        c.env.DB,
        `SELECT COUNT(*) uploads,COALESCE(SUM((SELECT SUM(size) FROM hub_release r WHERE r.item_id=i.id)),0) total_bytes FROM hub_item i WHERE ${PUBLIC}`,
      );
  const cost = fragment
    ? null
    : await one<
        Pick<
          Table<"worker_monthly_cost">,
          "amount_cents" | "month" | "updated_at"
        >
      >(
        c.env.DB,
        "SELECT amount_cents,month,updated_at FROM worker_monthly_cost WHERE id=1",
      );
  const monthly_cost =
    cost && Date.now() - Date.parse(cost.updated_at) < 3 * 86400000
      ? "$" + (cost.amount_cents / 100).toFixed(2)
      : null;
  if (template === "hub/donate.html")
    data = { ...data, cost_estimate: await readEstimate(c.env) };
  const uri = new URL(c.req.url);
  const context = {
    public_url: c.env.PUBLIC_URL.replace(/\/$/, ""),
    seo: {
      title: "CPC Hub — Car Park Capital community exchange",
      description: "Community blueprints and scenarios for Car Park Capital.",
      canonical: c.env.PUBLIC_URL + uri.pathname,
      robots: "noindex, nofollow",
    },
    request: {
      path: uri.pathname,
      GET: Object.fromEntries(uri.searchParams),
      resolver_match: {
        url_name: Object.keys(routes).find((k) => routes[k] === uri.pathname),
      },
    },
    user: u ? { ...u, pk: u.id } : null,
    csrf_token: csrf,
    site_totals: totals,
    monthly_cost,
    monthly_cost_period: cost?.month,
    pending_checks: data.item?.upload_jobs?.some((j) => j.status === "pending"),
    site_role: u?.role || "",
    can_moderate: staff(u),
    can_manage_content: manage(u),
    is_site_admin: admin(u),
    kofi_page_url: c.env.KOFI_PAGE_URL,
    querystring: (values: Row) => {
      const p = new URLSearchParams(uri.searchParams);
      for (const [k, v] of Object.entries(values)) p.set(k, String(v));
      return "?" + p;
    },
    ...data,
  };
  return c.html(environment.render(template, context), status);
}
export function csrfToken(c: Context<App>) {
  let token = c.get("user")?.csrf || getCookie(c, "cpc_csrf");
  if (!token) {
    token = random();
    setCookie(c, "cpc_csrf", token, {
      secure: c.env.PUBLIC_URL.startsWith("https:"),
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
  }
  return token;
}
export function input(
  name: string,
  label: string,
  value: unknown = "",
  type = "text",
  attrs = "",
) {
  return `<p><label for="id_${esc(name)}">${esc(label)}</label><input id="id_${esc(name)}" name="${esc(name)}" type="${esc(type)}" value="${type === "file" ? "" : esc(value)}" ${attrs}></p>`;
}
export function area(name: string, label: string, value = "", max = 20000) {
  return `<p><label for="id_${esc(name)}">${esc(label)}</label><textarea id="id_${esc(name)}" name="${esc(name)}" maxlength="${max}" rows="7">${esc(value)}</textarea></p>`;
}
export function select(
  name: string,
  label: string,
  options: Row[],
  value: unknown,
) {
  return `<p><label for="id_${esc(name)}">${esc(label)}</label><select id="id_${esc(name)}" name="${esc(name)}">${options.map((o) => `<option value="${esc(o.value)}" ${String(value) === String(o.value) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></p>`;
}
export const form = (html: string) => ({ as_p: safe(html) });

export async function viewItems(
  env: Env,
  items: CatalogItem[],
  u: User | null,
) {
  const loaded = await serializeMany(env, items, u);
  return Promise.all(items.map((i, n) => viewItem(env, i, u, loaded[n])));
}
