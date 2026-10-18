import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import type { DatabaseTables } from "../../src/database.generated";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../../src/index";
import { hash, uuid, now, type Env } from "../../src/env";

// Executes the application's real SQL and migrations. Remote storage/services are doubles.
export async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync("migrations/" + file, "utf8"));
  const sqlValue = (value: unknown): SQLInputValue => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    )
      return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new TypeError("Unsupported SQL parameter");
  };
  const meta = (): D1Meta & Record<string, unknown> => {
    const result = sqlite
      .prepare("SELECT changes() changes, last_insert_rowid() last_row_id")
      .get()!;
    return {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      changed_db: true,
      changes: Number(result.changes),
      last_row_id: Number(result.last_row_id),
    };
  };
  const execute = new WeakMap<D1PreparedStatement, () => D1Result<unknown>>();
  function prepare(sql: string): D1PreparedStatement {
    let values: SQLInputValue[] = [];
    const statement = {
      bind(...args: unknown[]) {
        values = args.map(sqlValue);
        return statement;
      },
      async first<T>(column?: string): Promise<T | null> {
        const row = sqlite.prepare(sql).get(...values);
        return (column ? (row?.[column] ?? null) : (row ?? null)) as T | null;
      },
      async all<T>(): Promise<D1Result<T>> {
        const results = sqlite.prepare(sql).all(...values) as T[];
        return { success: true, results, meta: meta() };
      },
      async run<T>(): Promise<D1Result<T>> {
        return statement.all<T>();
      },
      async raw<T = unknown[]>(options?: {
        columnNames?: boolean;
      }): Promise<T[]> {
        const query = sqlite.prepare(sql);
        const rows = query.all(...values).map((row) => Object.values(row));
        return (
          options?.columnNames
            ? [query.columns().map((column) => column.name), ...rows]
            : rows
        ) as T[];
      },
    };
    // D1's overloaded raw() signature also allows a leading column-name tuple.
    execute.set(statement as D1PreparedStatement, () => ({
      success: true,
      results: sqlite.prepare(sql).all(...values),
      meta: meta(),
    }));
    return statement as D1PreparedStatement;
  }
  const db: D1Database = {
    prepare,
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec("BEGIN");
      try {
        const result: D1Result<T>[] = [];
        for (const statement of statements)
          result.push(execute.get(statement)!() as D1Result<T>);
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    withSession() {
      return { prepare, batch: db.batch, getBookmark: () => null };
    },
    async dump() {
      throw new Error("Not supported in local fixture");
    },
  };
  function insert<K extends keyof DatabaseTables>(
    table: K,
    values: Omit<Partial<DatabaseTables[K]>, "id"> & {
      id?: string | number | null;
    },
  ): DatabaseTables[K] {
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all();
    const row: Record<string, SQLInputValue> = {};
    for (const column of columns) {
      const name = String(column.name);
      if (
        column.notnull &&
        !column.pk &&
        column.dflt_value === null &&
        !Object.hasOwn(values, name)
      )
        row[name] = /int|bool/i.test(String(column.type))
          ? 0
          : /date/i.test(String(column.type))
            ? now()
            : "";
    }
    for (const [key, value] of Object.entries(values))
      row[key] = sqlValue(value);
    const keys = Object.keys(row);
    return sqlite
      .prepare(
        `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) RETURNING *`,
      )
      .get(...Object.values(row)) as DatabaseTables[K];
  }
  insert("auth_user", { id: 1, username: "Author", is_active: 1 });
  insert("auth_user", { id: 2, username: "Other", is_active: 1 });
  insert("hub_uploadsettings", { id: 1, max_file_mb: 15 });
  sqlite.exec("UPDATE hub_tagsettings SET minimum_items=1 WHERE id=1");
  await db
    .prepare("INSERT INTO worker_session VALUES (?,?,?,?)")
    .bind(await hash("test-session"), 1, "test-csrf", Date.now() + 3600000)
    .run();
  const key = "cpc_test_secret";
  insert("hub_apikey", {
    id: uuid(),
    user_id: 1,
    name: "Test",
    prefix: "test",
    digest: await hash(key),
    scopes: '["read","write"]',
  });
  const objects = new Map<string, Uint8Array>();
  const metadata = (key: string, bytes: Uint8Array): R2Object => ({
    key,
    version: "1",
    size: bytes.length,
    etag: "test",
    httpEtag: '"test"',
    uploaded: new Date(),
    storageClass: "Standard",
    checksums: { toJSON: () => ({}) },
    writeHttpMetadata() {},
  });
  const toBytes = async (value: Parameters<R2Bucket["put"]>[1]) => {
    if (ArrayBuffer.isView(value))
      return new Uint8Array(
        value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        ),
      );
    return new Uint8Array(await new Response(value).arrayBuffer());
  };
  const bucket: R2Bucket = {
    async createMultipartUpload(key) {
      const chunks: Uint8Array[] = [];
      return {
        key,
        uploadId: uuid(),
        async uploadPart(partNumber, value) {
          chunks[partNumber - 1] = await toBytes(value);
          return { partNumber, etag: "test" };
        },
        async complete() {
          const merged = new Uint8Array(
            chunks.reduce((n, b) => n + b.length, 0),
          );
          let at = 0;
          for (const chunk of chunks) {
            merged.set(chunk, at);
            at += chunk.length;
          }
          objects.set(key, merged);
          return metadata(key, merged);
        },
        async abort() {
          objects.delete(key);
        },
      };
    },
    resumeMultipartUpload() {
      throw new Error("Not supported in local fixture");
    },
    async put(key, value) {
      const bytes = await toBytes(value);
      objects.set(key, bytes);
      return metadata(key, bytes);
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? metadata(key, bytes) : null;
    },
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const response = new Response(bytes);
      return {
        ...metadata(key, bytes),
        writeHttpMetadata() {},
        body: response.body!,
        get bodyUsed() {
          return response.bodyUsed;
        },
        arrayBuffer: () => response.arrayBuffer(),
        bytes: () => response.bytes(),
        text: () => response.text(),
        json: <T>() => response.json<T>(),
        blob: () => response.blob(),
      };
    },
    async delete(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys)
        objects.delete(key);
    },
    async list() {
      return {
        objects: [...objects].map(([key, bytes]) => metadata(key, bytes)),
        truncated: false,
        delimitedPrefixes: [],
      };
    },
  };
  const counts = new Map<string, Map<string, number>>();
  const limiter = (name: string, limit: number): RateLimit => ({
    async limit({ key }) {
      const seen = counts.get(name) ?? new Map<string, number>();
      counts.set(name, seen);
      const value = (seen.get(key) ?? 0) + 1;
      seen.set(key, value);
      return { success: value <= limit };
    },
  });
  const bindings = z
    .object({
      ratelimits: z.array(
        z.object({ name: z.string(), simple: z.object({ limit: z.number() }) }),
      ),
    })
    .parse(JSON.parse(readFileSync("wrangler.jsonc", "utf8")));
  const rateLimits = Object.fromEntries(
    bindings.ratelimits.map((binding) => [
      binding.name,
      limiter(binding.name, binding.simple.limit),
    ]),
  );
  const env: Env = {
    DB: db,
    PUBLIC_URL: "https://cpchub.net",
    SCREENSHOT_URL: "https://screenshots.cpchub.net",
    KOFI_PAGE_URL: "https://ko-fi.com/cpchub",
    FILES: bucket,
    QUARANTINE: bucket,
    PUBLIC_IMAGES: bucket,
    UPLOADS: {
      async send() {
        return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
      },
      async sendBatch() {
        return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
      },
      async metrics() {
        return { backlogBytes: 0, backlogCount: 0 };
      },
    },
    CF_ANALYTICS_TOKEN: "",
    CF_BILLING_TOKEN: "",
    CF_ACCOUNT_ID: "",
    DISCORD_CLIENT_ID: "test-discord-client",
    DISCORD_CLIENT_SECRET: "test-discord-secret",
    STEAM_API_KEY: "test-steam-key",
    API_ANON_RATE_LIMIT: rateLimits.API_ANON_RATE_LIMIT!,
    API_AUTH_RATE_LIMIT: rateLimits.API_AUTH_RATE_LIMIT!,
    SENSITIVE_ANON_RATE_LIMIT: rateLimits.SENSITIVE_ANON_RATE_LIMIT!,
    SENSITIVE_AUTH_RATE_LIMIT: rateLimits.SENSITIVE_AUTH_RATE_LIMIT!,
    VALIDATOR: {
      connect() {
        throw new Error("No sockets in service fixture");
      },
      async fetch() {
        return new Response("Not configured", { status: 503 });
      },
    } as Fetcher,
    IMAGE_VALIDATOR: {
      connect() {
        throw new Error("No sockets in service fixture");
      },
      async fetch() {
        return new Response("Not configured", { status: 503 });
      },
    } as Fetcher,
    ASSETS: {
      connect() {
        throw new Error("No sockets in service fixture");
      },
      async fetch(request: Request) {
        return new Response(
          readFileSync("public" + new URL(request.url).pathname),
          { headers: { "Content-Type": "application/yaml" } },
        );
      },
    } as Fetcher,
  };
  const background: Promise<unknown>[] = [];
  const context = {
    waitUntil(p: Promise<unknown>) {
      background.push(p);
    },
    passThroughOnException() {},
  } as ExecutionContext;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { async match() {}, async put() {} } },
  });
  async function rawRequest(path: string, init: RequestInit) {
    const response = await worker.fetch(
      new Request("https://cpchub.net" + path, init),
      env,
      context,
    );
    await Promise.all(background.splice(0));
    return response;
  }
  async function request(
    path: string,
    method = "GET",
    data?: unknown,
    auth: "session" | "key" | "anonymous" = "session",
  ) {
    const headers = new Headers();
    if (auth === "session") {
      headers.set("Cookie", "cpc_session=test-session");
      headers.set("X-CSRFToken", "test-csrf");
    } else if (auth === "key") headers.set("Authorization", "ApiKey " + key);
    let body: BodyInit | null = null;
    if (data instanceof FormData) body = data;
    else if (data !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(data);
    }
    const response = await worker.fetch(
      new Request("https://cpchub.net" + path, { method, headers, body }),
      env,
      context,
    );
    await Promise.all(background.splice(0));
    return response;
  }
  return {
    sqlite,
    env,
    db,
    context,
    background,
    insert,
    request,
    rawRequest,
    objects,
    key,
    close: () => sqlite.close(),
  };
}
