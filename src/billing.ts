import { z } from "zod";
const billingResponse = z.object({
  success: z.boolean(),
  result: z.array(z.record(z.string(), z.unknown())),
  result_info: z.object({ total_pages: z.number().optional() }).optional(),
});
import { Env, Row, run, now } from "./env";
export function monthlyInvoiceTotal(rows: Row[], month: string) {
  const seen = new Set<string>();
  let cents = 0;
  for (const row of rows) {
    if (
      row.type !== "invoice" ||
      !String(row.occurred_at).startsWith(month) ||
      ["VOID", "VOIDED", "DRAFT", "DELETED"].includes(
        String(row.status).toUpperCase(),
      )
    )
      continue;
    const id = String(row.invoice_id || row.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (
      String(row.currency).toUpperCase() !== "USD" ||
      typeof row.amount !== "number" ||
      !Number.isFinite(row.amount)
    )
      throw Error("Unsupported or incomplete billing amount");
    cents += Math.round(row.amount * 100);
  }
  return cents;
}
export async function refreshMonthlyCosts(env: Env) {
  if (!env.CF_BILLING_TOKEN || !env.CF_ACCOUNT_ID) return;
  const t = Date.now();
  const lease = await run(
    env.DB,
    "INSERT INTO worker_task(name,lease_until) VALUES ('billing',?) ON CONFLICT(name) DO UPDATE SET lease_until=excluded.lease_until WHERE worker_task.lease_until<?",
    t + 6 * 3600000,
    t,
  );
  if (!lease.meta.changes) return;
  try {
    const rows: Row[] = [],
      month = now().slice(0, 7);
    let complete = false;
    for (let page = 1; page <= 20; page++) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/billing/history?page=${page}&per_page=100`,
        {
          headers: { Authorization: "Bearer " + env.CF_BILLING_TOKEN },
          signal: AbortSignal.timeout(15000),
        },
      );
      const payload = billingResponse.parse(await response.json());
      if (!response.ok || !payload.success) throw Error("Billing fetch failed");
      rows.push(...payload.result);
      // History is ordered newest first. Stop after covering the current month or all pages.
      if (
        !payload.result.length ||
        payload.result.some(
          (r: Row) => String(r.occurred_at).slice(0, 7) < month,
        ) ||
        (payload.result_info?.total_pages &&
          page >= payload.result_info.total_pages)
      ) {
        complete = true;
        break;
      }
    }
    if (!complete) throw Error("Billing pagination incomplete");
    const cents = monthlyInvoiceTotal(rows, month);
    await run(
      env.DB,
      "INSERT INTO worker_monthly_cost VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET amount_cents=excluded.amount_cents,currency=excluded.currency,month=excluded.month,updated_at=excluded.updated_at",
      cents,
      "USD",
      month,
      now(),
    );
  } catch {
    await run(
      env.DB,
      "UPDATE worker_task SET lease_until=? WHERE name='billing'",
      t + 3600000,
    );
    console.error("Monthly cost refresh failed; retaining previous total.");
  }
}
