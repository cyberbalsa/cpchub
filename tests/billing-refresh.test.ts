import test from "node:test";
import assert from "node:assert/strict";
import { refreshMonthlyCosts, monthlyInvoiceTotal } from "../src/billing";
import { fixture } from "./helpers/app";
import { now } from "../src/env";

const invoice = () => ({
  type: "invoice",
  invoice_id: "one",
  occurred_at: now(),
  status: "CLOSED",
  currency: "USD",
  amount: 2.25,
});
void test("billing refresh handles absent credentials, pagination and its six-hour lease", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const fetcher = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      result: [invoice()],
      result_info: { total_pages: 1 },
    }),
  );
  await refreshMonthlyCosts(f.env);
  f.env.CF_BILLING_TOKEN = "test";
  f.env.CF_ACCOUNT_ID = "test";
  f.env.CF_ACCOUNT_ID = "";
  await refreshMonthlyCosts(f.env);
  assert.equal(fetcher.mock.callCount(), 0);
  f.env.CF_ACCOUNT_ID = "test";
  await refreshMonthlyCosts(f.env);
  await refreshMonthlyCosts(f.env);
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(
    f.sqlite.prepare("SELECT amount_cents FROM worker_monthly_cost").get()!
      .amount_cents,
    225,
  );
  assert.equal(
    monthlyInvoiceTotal(
      [
        { ...invoice(), invoice_id: "", id: "" },
        { ...invoice(), invoice_id: "two", id: "same" },
      ],
      now().slice(0, 7),
    ),
    225,
  );
});

void test("billing covers all pages until older invoices or an empty result and deduplicates invoice IDs", async (t) => {
  for (const stop of ["older", "empty"] as const) {
    const f = await fixture();
    t.after(f.close);
    f.env.CF_BILLING_TOKEN = "test";
    f.env.CF_ACCOUNT_ID = "test";
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json({
        success: true,
        result:
          calls === 1
            ? [invoice()]
            : stop === "empty"
              ? []
              : [
                  invoice(),
                  {
                    ...invoice(),
                    invoice_id: "old",
                    occurred_at: "2000-01-01",
                  },
                ],
      });
    });
    await refreshMonthlyCosts(f.env);
    assert.equal(calls, 2);
    assert.equal(
      f.sqlite.prepare("SELECT amount_cents FROM worker_monthly_cost").get()!
        .amount_cents,
      225,
    );
  }
});

void test("failed or incomplete billing refreshes preserve the last total and retry in one hour", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  for (const mode of [
    "http",
    "success",
    "schema",
    "pages",
    "network",
  ] as const) {
    const f = await fixture();
    t.after(f.close);
    f.env.CF_BILLING_TOKEN = "test";
    f.env.CF_ACCOUNT_ID = "test";
    f.insert("worker_monthly_cost", {
      id: 1,
      amount_cents: 1234,
      currency: "USD",
      month: now().slice(0, 7),
      updated_at: now(),
    });
    let calls = 0;
    const before = Date.now();
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (mode === "network") throw Error("offline");
      return Response.json(
        mode === "schema"
          ? {}
          : { success: mode !== "success", result: [invoice()] },
        { status: mode === "http" ? 503 : 200 },
      );
    });
    await refreshMonthlyCosts(f.env);
    assert.equal(calls, mode === "pages" ? 20 : 1);
    assert.equal(
      f.sqlite.prepare("SELECT amount_cents FROM worker_monthly_cost").get()!
        .amount_cents,
      1234,
    );
    const lease = Number(
      f.sqlite
        .prepare("SELECT lease_until FROM worker_task WHERE name='billing'")
        .get()!.lease_until,
    );
    assert(lease >= before + 3600000 && lease <= Date.now() + 3600000);
  }
  assert.equal(errors.mock.callCount(), 5);
});
