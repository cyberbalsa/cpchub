import test from "node:test";
import assert from "node:assert/strict";
import SwaggerParser from "@apidevtools/swagger-parser";
import { api } from "../src/api";
import { oauth } from "../src/oauth";
import { METRICS, serialize } from "../src/catalog";
import { keyJSON } from "../src/api";
import { jobJSON } from "../src/uploads";
import { spec, check, validator } from "./helpers/openapi";
import { now, type Env } from "../src/env";

const normalize = (path: string) => path.replace(/:[^/]+|\{[^}]+\}/g, "{}");
void test("OpenAPI 3.1 is valid and covers every registered API and OAuth operation exactly once", async () => {
  await SwaggerParser.validate("public/openapi.yaml");
  const actual = [
    ...api.routes.map((r) => r.method + " " + normalize("/api/v1" + r.path)),
    ...oauth.routes.map((r) => r.method + " " + normalize("/o" + r.path)),
  ].sort();
  const documented = Object.entries(spec.paths)
    .flatMap(([p, methods]) =>
      Object.keys(methods as object).map(
        (m) => m.toUpperCase() + " " + normalize(p),
      ),
    )
    .sort();
  assert.deepEqual(documented, actual);
  const ids = new Set();
  for (const [path, methods] of Object.entries(spec.paths))
    for (const op of Object.values(methods)) {
      assert(!ids.has(op.operationId));
      ids.add(op.operationId);
      for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]))
        assert(
          op.parameters?.some(
            (p) => p.in === "path" && p.name === name && p.required,
          ),
        );
    }
  assert.equal(spec.components.securitySchemes.cookieAuth!.name, "cpc_session");
  assert(spec.servers.some((s) => s.url === "https://cpchub.net"));
});
void test("all file-statistic filters and catalog views are documented", () => {
  const params = spec.paths["/api/v1/items/"]!.get!.parameters!;
  assert.deepEqual(
    params.map((p) => p.name).sort(),
    [
      ...METRICS.flatMap((m) => ["min_" + m, "max_" + m]),
      "mine",
      "view",
      "author",
      "page",
      "q",
      "sort",
      "tag",
      "type",
    ].sort(),
  );
  for (const metric of METRICS)
    assert(
      Object.hasOwn(spec.components.schemas.FileStats!.properties!, metric),
    );
});

const date = now(),
  id = "12345678-1234-4234-8234-123456789abc";
const stats = {
  schema_version: 1,
  kind: "blueprint",
  format_version: 3,
  width: 1,
  depth: 1,
  height: 1,
  footprint_tiles: 1,
  objects: 0,
  object_types: 0,
  parking_spaces: 0,
  golf_cart_spaces: 0,
  entrances: 0,
  exits: 0,
  maps: null,
  entities: null,
};
const key = keyJSON({
  id: id.replaceAll("-", ""),
  digest: "test",
  application_id: null,
  user_id: 1,
  name: "Manager",
  prefix: "abc",
  scopes: '["read","write"]',
  created_at: date,
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
});
const release = {
  id,
  version: "1.0",
  game_version: "1",
  changelog: "Notes",
  original_filename: "test.cpbp",
  sha256: "a".repeat(64),
  size: 14,
  downloads: 0,
  created_at: date,
  file_stats: stats,
  download_url:
    "https://cpchub.net/api/v1/items/" + id + "/releases/" + id + "/download/",
};
const shot = {
  id,
  caption: "A screenshot",
  created_at: date,
  image_url: "https://screenshots.cpchub.net/test.webp",
};
const item = {
  id,
  title: "Example",
  summary: "Summary",
  description: "Description",
  content_type: "blueprints",
  author: "Author",
  tags: "parking",
  status: "draft",
  publish_after_validation: false,
  is_demo: false,
  is_hidden: false,
  hidden_reason: "",
  deleted_at: null,
  featured_at: null,
  downloads: 0,
  collection_count: 0,
  created_at: date,
  updated_at: date,
  releases: [release],
  screenshots: [shot],
};
const itemRequest = {
  title: "Example",
  summary: "Summary",
  description: "Description",
  content_type: "blueprints",
  status: "draft",
  tags: "parking",
};
const job = jobJSON({
  id: id.replaceAll("-", ""),
  kind: "release",
  size: 14,
  sha256: "a".repeat(64),
  metadata: "{}",
  item_id: id,
  submitted_by_id: 1,
  status: "pending",
  original_filename: "test.cpbp",
  error: "",
  release_id: null,
  screenshot_id: null,
  created_at: date,
  completed_at: null,
});
const examples: Record<string, unknown> = {
  RateLimitError: { error: "rate_limited", retry_after: 60 },
  ContentType: {
    slug: "blueprints",
    name: "Blueprints",
    description: "Native blueprints",
    allowed_extensions: [".cpbp"],
    uploads_enabled: true,
    max_upload_bytes: 15728640,
  },
  Error: { status: 400, errors: { detail: "Invalid request." } },
  FileStats: stats,
  FileStatsKindEnum: "blueprint",
  IssuedKey: { ...key, key: "cpc_example" },
  Item: item,
  ItemRequest: itemRequest,
  ItemStatusEnum: "draft",
  Key: key,
  KeyCreateRequest: { name: "Manager", scopes: ["read"], days: null },
  PaginatedItemList: { count: 1, next: null, previous: null, results: [item] },
  PaginatedKeyList: { count: 1, next: null, previous: null, results: [key] },
  PaginatedTagList: {
    count: 1,
    next: null,
    previous: null,
    results: [{ name: "parking", item_count: 1 }],
  },
  PatchedItemRequest: { title: "Changed" },
  Profile: { id: 1, username: "Author" },
  Release: release,
  ReleaseUploadRequest: { file: "binary bytes", version: "1.0" },
  Revision: { id: 1, snapshot: itemRequest, created_at: date },
  ScopesEnum: "read",
  Screenshot: shot,
  ScreenshotUploadRequest: { image: "binary bytes", caption: "Screenshot" },
  Tag: { name: "parking", item_count: 1 },
  TagSuggestion: { name: "parking" },
  UploadJob: job,
  UploadJobKindEnum: "release",
  UploadJobStatusEnum: "pending",
  OAuthError: { error: "invalid_grant", error_description: "Expired grant." },
  OAuthToken: {
    access_token: "access",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "refresh",
    scope: "read",
  },
  OAuthTokenRequest: {
    grant_type: "authorization_code",
    client_id: "client",
    redirect_uri: "https://example.com/callback",
    code: "code",
    code_verifier: "a".repeat(43),
  },
  OAuthRevokeRequest: { client_id: "client", token: "token" },
  OAuthAuthorizeRequest: {
    client_id: "client",
    redirect_uri: "https://example.com/callback",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: "a".repeat(43),
    approve: "yes",
    csrfmiddlewaretoken: "csrf",
  },
};
void test("every component datatype has a valid example and rejects incorrect types", () => {
  assert.deepEqual(
    Object.keys(examples).sort(),
    Object.keys(spec.components.schemas).sort(),
    "New datatypes need explicit fixtures",
  );
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    check(name, examples[name]);
    const validate = validator({ $ref: "#/components/schemas/" + name });
    assert(!validate(42), name + " rejects numeric payloads");
    for (const required of schema.required || []) {
      const value = structuredClone(examples[name]) as Record<string, unknown>;
      delete value[required];
      assert(!validate(value), `${name}.${required} is required`);
    }
    for (const [field, property] of Object.entries(schema.properties || {})) {
      assert(
        property.type || property.$ref || property.allOf || property.oneOf,
        `${name}.${field} must declare a datatype`,
      );
      const v = validator(property);
      assert(
        !v(property.type === "array" ? 42 : ["wrong", "datatype"]),
        `${name}.${field} rejects incorrect datatypes`,
      );
    }
  }
});
void test("nullable values, enum variants, arrays, UUIDs, timestamps and bounds are enforced", () => {
  for (const [name, schema] of Object.entries(spec.components.schemas))
    if (schema.enum) for (const value of schema.enum) check(name, value);
  check("FileStats", {
    ...stats,
    kind: "scenario",
    format_version: null,
    maps: 1,
    entities: 0,
    objects: null,
    object_types: null,
  });
  check("FileStats", {});
  check("PatchedItemRequest", {});
  check("OAuthTokenRequest", {
    grant_type: "refresh_token",
    client_id: "client",
    refresh_token: "refresh",
  });
  for (const [name, patch] of [
    ["Item", { id: "invalid" }],
    ["Item", { created_at: "yesterday" }],
    ["Item", { is_hidden: 0 }],
    ["FileStats", { width: 0 }],
    ["Key", { scopes: "read" }],
    ["KeyCreateRequest", { scopes: [] }],
    ["KeyCreateRequest", { days: 0 }],
    ["KeyCreateRequest", { days: 91 }],
    ["ContentType", { allowed_extensions: [42] }],
  ] as const) {
    const v = validator({ $ref: "#/components/schemas/" + name });
    assert(
      !v({ ...(examples[name] as Record<string, unknown>), ...patch }),
      name + JSON.stringify(patch),
    );
  }
});
void test("item serializer fields and absolute URLs match the contract", async () => {
  const output = await serialize(
    {
      PUBLIC_URL: "https://cpchub.net",
      SCREENSHOT_URL: "https://screenshots.cpchub.net",
    } as Env,
    {
      ...item,
      type_name: "Blueprints",
      artwork: 0,
      content_type_id: 1,
      featured_by_id: null,
      hidden_at: null,
      hidden_by_id: null,
      content_revision: 1,
      reviewed_revision: 0,
      review_requested_at: date,
      id: id.replaceAll("-", ""),
      username: "Author",
      author_id: 1,
      type_slug: "blueprints",
      is_demo: 0,
      is_hidden: 0,
      publish_after_validation: 0,
    },
    null,
    {
      releases: [
        {
          ...release,
          item_id: id,
          file: "test.cpbp",
          id: id.replaceAll("-", ""),
          file_stats: JSON.stringify(stats),
        },
      ],
      screenshots: [
        {
          ...shot,
          item_id: id,
          id: id.replaceAll("-", ""),
          image: "legacy.webp",
        },
      ],
      tags: [{ name: "parking", item_count: 1 }],
    },
  );
  check("Item", output);
  assert.deepEqual(
    Object.keys(output).sort(),
    Object.keys(spec.components.schemas.Item!.properties!).sort(),
  );
  assert(output.releases[0]!.download_url.startsWith("https://cpchub.net/"));
  assert(output.screenshots[0]!.image_url.startsWith("https://cpchub.net/"));
});
