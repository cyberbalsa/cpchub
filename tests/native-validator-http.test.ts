import test from "node:test";
import assert from "node:assert/strict";
import worker from "../workers/validator/index";
import { blueprint, scenario } from "./helpers/native";
void test("native validator HTTP entry point validates both formats and strips internal resource accounting", async () => {
  for (const method of ["GET", "POST"])
    assert.equal(
      (await worker.fetch(new Request("https://validator/", { method })))
        .status,
      405,
    );
  for (const [kind, bytes] of [
    ["blueprint", blueprint()],
    ["scenario", scenario()],
  ] as const) {
    const response = await worker.fetch(
      new Request("https://validator/", {
        method: "POST",
        headers: { "x-kind": kind, "x-size": String(bytes.length) },
        body: bytes,
      }),
    );
    assert.equal(response.status, 200);
    const stats = await response.json<Record<string, unknown>>();
    assert.equal(stats.kind, kind);
    assert.equal(stats.width, 1);
    assert(!("_resources" in stats));
  }
});
void test("invalid native files and decoder exceptions return a bounded public error", async () => {
  for (const headers of [
    {},
    { "x-kind": "wrong", "x-size": "1" },
    { "x-kind": "scenario", "x-size": "5" },
  ]) {
    const response = await worker.fetch(
      new Request("https://validator/", {
        method: "POST",
        headers,
        body: new Uint8Array([1, 2, 3, 4, 5]),
      }),
    );
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "invalid_file" });
  }
});
