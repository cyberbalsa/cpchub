import { z } from "zod";
const object = z.record(z.string(), z.unknown());
const analyticsResponse = z.object({
  errors: z.array(z.unknown()).nullish(),
  data: z
    .object({
      viewer: z.object({
        accounts: z.array(z.record(z.string(), z.array(object))),
      }),
    })
    .optional(),
});
const estimateSchema = z.object({
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      formula: z.string(),
      cents: z.number().nullable(),
      amount: z.string(),
      usage: z.string(),
    }),
  ),
  total: z.string(),
  totalCents: z.number(),
  complete: z.boolean(),
  month: z.string(),
  updated_at: z.string(),
});
import { Env, Row, one, run, now } from "./env";

// Calendar-month estimates, before tax and billing-unit rounding. Analytics are
// approximate and may lag billing. Never turn missing or failed data into $0.
export const money = (cents: number) => "$" + (cents / 100).toFixed(2);
const definitions = [
  {
    key: "hosting",
    label: "Hosting usage",
    formula:
      "Requests above 10 million ÷ 1 million × $0.30 + CPU milliseconds above 30 million ÷ 1 million × $0.02.",
  },
  {
    key: "storage",
    label: "File storage",
    formula:
      "GB-months above 10 × $0.015 + Class A operations above 1 million ÷ 1 million × $4.50 + Class B operations above 10 million ÷ 1 million × $0.36.",
  },
  {
    key: "database",
    label: "Database",
    formula:
      "GB-months above 5 × $0.75 + rows read above 25 billion ÷ 1 million × $0.001 + rows written above 50 million ÷ 1 million × $1.00.",
  },
  {
    key: "queues",
    label: "Upload checks",
    formula:
      "Operations above 1 million ÷ 1 million × $0.40. Processing time is included in hosting usage.",
  },
  {
    key: "images",
    label: "Screenshot processing",
    formula: "Transformations above 5,000 ÷ 1,000 × $0.50.",
  },
];
const excess = (value: number, included: number, unit: number, rate: number) =>
  (Math.max(0, value - included) / unit) * rate;
const count = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 3 });
function sum(rows: Row[] | undefined, field: string, group = "sum") {
  if (!rows?.length) throw Error("No usage reported");
  return rows.reduce((total, r) => {
    const nested = group ? object.safeParse(r[group]) : undefined;
    const n = group
      ? nested?.success
        ? nested.data[field]
        : undefined
      : r[field];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
      throw Error("Invalid usage");
    return total + n;
  }, 0);
}
function storage(rows: Row[] | undefined, fields: string[], days: number) {
  if (!rows?.length) throw Error("No storage reported");
  // Daily peak bytes provide a conservative estimate of GB-months used so far.
  return (
    fields.reduce((total, field) => total + sum(rows, field, "max"), 0) /
    1e9 /
    days
  );
}
export function calculateEstimates(
  data: Record<string, Row[] | undefined>,
  at = new Date(),
) {
  const days = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const rows = definitions.map((def) => {
    try {
      let dollars = 0,
        usage = "";
      if (def.key === "hosting") {
        const requests = sum(data.workers, "requests"),
          cpu = sum(data.workers, "cpuTimeUs") / 1000;
        dollars = excess(requests, 1e7, 1e6, 0.3) + excess(cpu, 3e7, 1e6, 0.02);
        usage = `${count(requests)} requests; ${count(cpu)} CPU ms`;
      } else if (def.key === "storage") {
        const gb = storage(data.r2storage, ["payloadSize", "metadataSize"], 30);
        if (!data.r2?.length) throw Error("No operations reported");
        const aTypes = new Set([
          "ListBuckets",
          "PutBucket",
          "ListObjects",
          "PutObject",
          "CopyObject",
          "CompleteMultipartUpload",
          "CreateMultipartUpload",
          "ListMultipartUploads",
          "UploadPart",
          "UploadPartCopy",
          "ListParts",
          "PutBucketEncryption",
          "PutBucketLifecycleConfiguration",
          "PutBucketCors",
        ]);
        const bTypes = new Set([
          "HeadBucket",
          "HeadObject",
          "GetObject",
          "UsageSummary",
          "GetBucketEncryption",
          "GetBucketLocation",
          "GetBucketLifecycleConfiguration",
          "GetBucketCors",
        ]);
        const freeTypes = new Set([
          "DeleteObject",
          "DeleteObjects",
          "DeleteBucket",
          "AbortMultipartUpload",
        ]);
        let a = 0,
          b = 0,
          unclassified = 0;
        for (const r of data.r2) {
          const dimensions = object.safeParse(r.dimensions);
          const value = dimensions.success
            ? dimensions.data.actionType
            : undefined;
          const action = typeof value === "string" ? value : "";
          const n = sum([r], "requests");
          if (aTypes.has(action)) a += n;
          else if (bTypes.has(action)) b += n;
          else if (!freeTypes.has(action)) unclassified += n;
        }
        // Unknown control-plane calls cannot add charges while they fit in either allowance.
        if (unclassified && (a + unclassified > 1e6 || b + unclassified > 1e7))
          throw Error("Unknown billable R2 operation");
        dollars =
          excess(gb, 10, 1, 0.015) +
          excess(a, 1e6, 1e6, 4.5) +
          excess(b, 1e7, 1e6, 0.36);
        usage = `${count(gb)} GB-months; ${count(a)} Class A; ${count(b)} Class B${unclassified ? `; ${count(unclassified)} other calls within free limits` : ""}`;
      } else if (def.key === "database") {
        const gb = storage(data.d1storage, ["databaseSizeBytes"], days),
          reads = sum(data.d1, "rowsRead"),
          writes = sum(data.d1, "rowsWritten");
        dollars =
          excess(gb, 5, 1, 0.75) +
          excess(reads, 25e9, 1e6, 0.001) +
          excess(writes, 5e7, 1e6, 1);
        usage = `${count(gb)} GB-months; ${count(reads)} rows read; ${count(writes)} rows written`;
      } else if (def.key === "queues") {
        const operations = sum(data.queues, "billableOperations");
        dollars = excess(operations, 1e6, 1e6, 0.4);
        usage = `${count(operations)} operations`;
      } else {
        if (!data.images?.length) throw Error("No transformations reported");
        // These daily snapshots are cumulative monthly uniques, so do not add them.
        const transformations = Math.max(
          ...data.images.map((r) => sum([r], "transformations", "")),
        );
        dollars = excess(transformations, 5000, 1000, 0.5);
        usage = `${count(transformations)} transformations`;
      }
      const cents = Math.round(dollars * 100);
      return { ...def, cents, amount: money(cents), usage };
    } catch {
      return {
        ...def,
        cents: null,
        amount: "Pending",
        usage: "No complete usage report yet.",
      };
    }
  });
  const totalCents = 3000 + rows.reduce((n, r) => n + (r.cents ?? 0), 0);
  return {
    rows,
    total: money(totalCents),
    totalCents,
    complete: rows.every((r) => r.cents !== null),
    month: at.toISOString().slice(0, 7),
    updated_at: at.toISOString(),
  };
}
export async function collectEstimates(
  env: Pick<Env, "CF_ANALYTICS_TOKEN" | "CF_ACCOUNT_ID">,
  at = new Date(),
) {
  const start = at.toISOString().slice(0, 7) + "-01T00:00:00Z",
    end = at.toISOString();
  const filter = `datetime_geq:${JSON.stringify(start)},datetime_lt:${JSON.stringify(end)}`;
  const queries: Record<string, string> = {
    workers: `workersInvocationsAdaptive(limit:100,filter:{${filter}}){sum{requests cpuTimeUs}}`,
    r2: `r2OperationsAdaptiveGroups(limit:1000,filter:{${filter},storageClass:"Standard"}){dimensions{actionType}sum{requests}}`,
    r2storage: `r2StorageAdaptiveGroups(limit:10000,filter:{${filter},storageClass:"Standard"}){dimensions{date bucketName}max{payloadSize metadataSize}}`,
    d1: `d1AnalyticsAdaptiveGroups(limit:100,filter:{${filter}}){sum{rowsRead rowsWritten}}`,
    d1storage: `d1StorageAdaptiveGroups(limit:10000,filter:{${filter}}){dimensions{date databaseId}max{databaseSizeBytes}}`,
    queues: `queueMessageOperationsAdaptiveGroups(limit:100,filter:{${filter}}){sum{billableOperations}}`,
    images: `imagesUniqueTransformationsAccumulatedSinceStartOfMonth(limit:40,filter:{date_geq:${JSON.stringify(start.slice(0, 10))},date_leq:${JSON.stringify(end.slice(0, 10))}}){date transformations}`,
  };
  const entries = await Promise.all(
    Object.entries(queries).map(async ([key, selection]) => {
      try {
        const response = await fetch(
          "https://api.cloudflare.com/client/v4/graphql",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + env.CF_ANALYTICS_TOKEN,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query: `{viewer{accounts(filter:{accountTag:${JSON.stringify(env.CF_ACCOUNT_ID)}}){${selection}}}}`,
            }),
            signal: AbortSignal.timeout(20000),
          },
        );
        const payload = analyticsResponse.parse(await response.json());
        if (
          !response.ok ||
          payload.errors?.length ||
          payload.data?.viewer?.accounts?.length !== 1
        )
          throw Error("Analytics unavailable");
        const rows = Object.values(payload.data!.viewer.accounts[0]!)[0];
        const limit = Number(selection.match(/limit:(\d+)/)?.[1]);
        if (!Array.isArray(rows) || rows.length >= limit)
          throw Error("Incomplete analytics");
        return [key, rows] as const;
      } catch {
        console.error("Cost analytics unavailable", key);
        return [key, undefined] as const;
      }
    }),
  );
  return calculateEstimates(Object.fromEntries(entries), at);
}
export async function refreshEstimates(env: Env) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return;
  const t = Date.now();
  const lease = await run(
    env.DB,
    "INSERT INTO worker_task(name,lease_until) VALUES ('cost-estimates',?) ON CONFLICT(name) DO UPDATE SET lease_until=excluded.lease_until WHERE worker_task.lease_until<?",
    t + 6 * 3600000,
    t,
  );
  if (!lease.meta.changes) return;
  try {
    const estimate = await collectEstimates(env);
    await run(
      env.DB,
      "INSERT INTO worker_cost_estimate(id,payload,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
      JSON.stringify(estimate),
      now(),
    );
  } catch {
    await run(
      env.DB,
      "UPDATE worker_task SET lease_until=? WHERE name='cost-estimates'",
      t + 3600000,
    );
    console.error("Cost estimate refresh failed");
  }
}
export async function readEstimate(env: Env) {
  const fallback = calculateEstimates({});
  const saved = await one<{ payload: string; updated_at: string }>(
    env.DB,
    "SELECT payload,updated_at FROM worker_cost_estimate WHERE id=1",
  );
  const age = saved ? Date.now() - Date.parse(saved.updated_at) : NaN;
  if (!saved || !Number.isFinite(age) || age < 0 || age > 3 * 86400000)
    return { ...fallback, updated_at: null };
  try {
    const parsed = estimateSchema.parse(JSON.parse(saved.payload));
    return parsed.month === fallback.month
      ? parsed
      : { ...fallback, updated_at: null };
  } catch {
    return { ...fallback, updated_at: null };
  }
}
