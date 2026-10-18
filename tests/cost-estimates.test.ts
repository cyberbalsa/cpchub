import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateEstimates,
  collectEstimates,
  readEstimate,
  refreshEstimates,
} from "../src/cost-estimates";
import { fixture } from "./helpers/app";
const at = new Date("2026-10-18T00:00:00Z");
const complete = () => ({
  workers: [{ sum: { requests: 0, cpuTimeUs: 0 } }],
  r2: [{ dimensions: { actionType: "GetObject" }, sum: { requests: 0 } }],
  r2storage: [{ max: { payloadSize: 0, metadataSize: 0 } }],
  d1: [{ sum: { rowsRead: 0, rowsWritten: 0 } }],
  d1storage: [{ max: { databaseSizeBytes: 0 } }],
  queues: [{ sum: { billableOperations: 0 } }],
  images: [{ transformations: 0 }],
});
void test("missing reports remain pending and only known costs enter the subtotal", () => {
  const result = calculateEstimates({}, at);
  assert.equal(result.total, "$30.00");
  assert.equal(result.complete, false);
  assert.ok(result.rows.every((r) => r.cents === null));
});
void test("explicit zero usage is a complete zero-overage estimate", () => {
  const result = calculateEstimates(complete(), at);
  assert.equal(result.total, "$30.00");
  assert.equal(result.complete, true);
  assert.ok(result.rows.every((r) => r.cents === 0));
});
void test("applies allowances, converts CPU microseconds, and sums displayed cents", () => {
  const data = complete();
  data.workers = [{ sum: { requests: 12e6, cpuTimeUs: 40e9 } }];
  data.r2 = [
    { dimensions: { actionType: "PutObject" }, sum: { requests: 2e6 } },
    { dimensions: { actionType: "GetObject" }, sum: { requests: 11e6 } },
  ];
  data.r2storage = [{ max: { payloadSize: 20 * 30 * 1e9, metadataSize: 0 } }];
  data.d1 = [{ sum: { rowsRead: 26e9, rowsWritten: 51e6 } }];
  data.d1storage = [{ max: { databaseSizeBytes: 6 * 31 * 1e9 } }];
  data.queues = [{ sum: { billableOperations: 2e6 } }];
  data.images = [{ transformations: 7000 }];
  const result = calculateEstimates(data, at);
  assert.deepEqual(
    result.rows.map((r) => r.cents),
    [80, 501, 275, 40, 100],
  );
  assert.equal(result.total, "$39.96");
  assert.equal(
    result.totalCents,
    3000 + result.rows.reduce((n, r) => n + r.cents!, 0),
  );
});
void test("invalid values and unknown operation types do not silently understate totals", () => {
  const data = complete();
  data.workers[0]!.sum.cpuTimeUs = NaN;
  data.r2[0]!.dimensions.actionType = "Unrecognized";
  data.r2[0]!.sum.requests = 2e6;
  const result = calculateEstimates(data, at);
  assert.equal(result.complete, false);
  assert.equal(result.rows[0]!.cents, null);
  assert.equal(result.rows[1]!.cents, null);
});
void test("stale snapshots fall back to fixed subtotal without stale usage", async () => {
  const f = await fixture();
  try {
    f.insert("worker_cost_estimate", {
      id: 1,
      payload: JSON.stringify(calculateEstimates(complete(), at)),
      updated_at: "2000-01-01T00:00:00Z",
    });
    const result = await readEstimate(f.env);
    assert.equal(result.total, "$30.00");
    assert.equal(result.updated_at, null);
  } finally {
    f.close();
  }
});
void test("GraphQL errors are treated as missing data", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ errors: [{ message: "denied" }] });
  try {
    const result = await collectEstimates(
      { CF_ANALYTICS_TOKEN: "test", CF_ACCOUNT_ID: "test" },
      at,
    );
    assert.equal(result.complete, false);
    assert.ok(result.rows.every((r) => r.cents === null));
  } finally {
    globalThis.fetch = original;
  }
});

void test("unclassified R2 calls below both allowances add no charge", () => {
  const data = complete();
  data.r2 = [
    {
      dimensions: { actionType: "GetBucketSippyConfiguration" },
      sum: { requests: 10 },
    },
  ];
  assert.equal(calculateEstimates(data, at).rows[1]!.cents, 0);
});

void test("monthly image snapshots do not charge again for repeated transformations", () => {
  const data = complete();
  data.images = [
    { transformations: 7000 },
    { transformations: 6000 },
    { transformations: 7000 },
  ];
  const result = calculateEstimates(data, at);
  assert.equal(result.rows[4]!.cents, 100);
  assert.equal(result.rows[4]!.usage, "7,000 transformations");
  assert.equal(result.total, "$31.00");
});

function analyticsResponse(init: RequestInit | undefined, truncated = false) {
  const parsed: unknown = JSON.parse(String(init?.body));
  assert(
    parsed &&
      typeof parsed === "object" &&
      "query" in parsed &&
      typeof parsed.query === "string",
  );
  const query = parsed.query;
  const datasets = {
    workersInvocationsAdaptive: "workers",
    r2OperationsAdaptiveGroups: "r2",
    r2StorageAdaptiveGroups: "r2storage",
    d1AnalyticsAdaptiveGroups: "d1",
    d1StorageAdaptiveGroups: "d1storage",
    queueMessageOperationsAdaptiveGroups: "queues",
    imagesUniqueTransformationsAccumulatedSinceStartOfMonth: "images",
  } as const;
  const field = Object.keys(datasets).find((name) =>
    query.includes(name + "("),
  );
  assert.ok(field, "Known analytics dataset");
  const rows = complete()[datasets[field as keyof typeof datasets]];
  const data =
    truncated && field === "r2StorageAdaptiveGroups"
      ? Array(10000).fill(rows[0])
      : rows;
  return Response.json({ data: { viewer: { accounts: [{ [field]: data }] } } });
}

void test("collector reads monthly image counts and excludes truncated categories", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    return analyticsResponse(init, true);
  };
  try {
    const result = await collectEstimates(
      { CF_ANALYTICS_TOKEN: "test", CF_ACCOUNT_ID: "test" },
      at,
    );
    assert.equal(calls, 7);
    assert.equal(result.complete, false);
    assert.equal(result.rows[1]!.cents, null);
    assert.ok(
      result.rows
        .filter((r) => r.key !== "storage")
        .every((r) => r.cents === 0),
    );
  } finally {
    globalThis.fetch = original;
  }
});

void test("invalid timestamps and previous-month snapshots stay pending", async () => {
  const f = await fixture();
  try {
    const now = new Date(),
      valid = calculateEstimates(complete(), now);
    for (const [payload, updated] of [
      [valid, "invalid"],
      [{ ...valid, month: "2000-01" }, now.toISOString()],
    ] as const) {
      await f.db
        .prepare("INSERT OR REPLACE INTO worker_cost_estimate VALUES (1,?,?)")
        .bind(JSON.stringify(payload), updated)
        .run();
      const result = await readEstimate(f.env);
      assert.equal(result.complete, false);
      assert.equal(result.total, "$30.00");
      assert.equal(result.updated_at, null);
    }
  } finally {
    f.close();
  }
});

void test("scheduled refresh saves an estimate once per lease; admin refresh updates the public total", async () => {
  const f = await fixture(),
    original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    return analyticsResponse(init);
  };
  try {
    f.env.CF_ANALYTICS_TOKEN = "test";
    f.env.CF_ACCOUNT_ID = "test";
    await refreshEstimates(f.env);
    assert.equal(calls, 7);
    assert.equal((await readEstimate(f.env)).complete, true);
    await refreshEstimates(f.env);
    assert.equal(calls, 7, "An active lease prevents another fetch");
    // A persisted subtotal must be replaced by the same action admins already use.
    await f.db
      .prepare("UPDATE worker_cost_estimate SET payload=? WHERE id=1")
      .bind(JSON.stringify(calculateEstimates({})))
      .run();
    f.sqlite.exec("UPDATE auth_user SET is_superuser=1 WHERE id=1");
    const refresh = await f.request("/admin/settings", "POST", {
      action: "refresh-costs",
    });
    assert.equal(refresh.status, 302);
    assert.equal(calls, 14);
    const saved = await readEstimate(f.env);
    assert.equal(saved.complete, true);
    const page = await f.request("/donate/");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Estimated total/);
    assert.doesNotMatch(html, /Estimated subtotal/);
    assert.match(
      html,
      /<tfoot>[\s\S]*?<strong>\$30\.00<\/strong>[\s\S]*?<\/tfoot>/,
    );
    assert.match(
      html,
      /<div class="support-cost"><strong>\$30\.00<\/strong><\/div>/,
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

void test("malformed usage groups and saved snapshots stay pending instead of inventing costs", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const valid = complete();
  for (const value of [
    { ...valid, workers: [{ sum: null }] },
    { ...valid, r2: [] },
    { ...valid, r2: [{ dimensions: null, sum: { requests: 1 } }] },
    {
      ...valid,
      r2: [{ dimensions: { actionType: 12 }, sum: { requests: 1 } }],
    },
  ]) {
    const estimate = calculateEstimates(value, at);
    assert(
      estimate.rows.some((row) => row.cents === null) ||
        estimate.total === "$30.00",
    );
  }
  for (const payload of ["not JSON", "{}"]) {
    f.sqlite
      .prepare("INSERT OR REPLACE INTO worker_cost_estimate VALUES (1,?,?)")
      .run(payload, new Date().toISOString());
    assert.equal((await readEstimate(f.env)).complete, false);
  }
  f.env.CF_ANALYTICS_TOKEN = "test";
  f.env.CF_ACCOUNT_ID = "test";
  f.sqlite.exec(
    "CREATE TRIGGER reject_cost BEFORE INSERT ON worker_cost_estimate BEGIN SELECT RAISE(ABORT,'storage unavailable'); END",
  );
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      analyticsResponse(init),
  );
  const log = t.mock.method(console, "error", () => {});
  const before = Date.now();
  await refreshEstimates(f.env);
  assert.equal(log.mock.callCount(), 1);
  assert(
    Number(
      f.sqlite
        .prepare(
          "SELECT lease_until FROM worker_task WHERE name='cost-estimates'",
        )
        .get()!.lease_until,
    ) >=
      before + 3600000,
  );
});
