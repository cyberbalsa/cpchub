import type { TestContext } from "node:test";
import assert from "node:assert/strict";

export function fragmentCache(t: TestContext) {
  let time = 0;
  const entries = new Map<string, { response: Response; expires: number }>();
  t.mock.method(caches.default, "match", async (key: Request) => {
    const entry = entries.get(key.url);
    return entry && entry.expires > time ? entry.response.clone() : undefined;
  });
  t.mock.method(
    caches.default,
    "put",
    async (key: Request, response: Response) => {
      assert.equal(response.headers.get("Cache-Control"), "public, max-age=60");
      assert.equal(response.headers.get("Set-Cookie"), null);
      entries.set(key.url, {
        response: response.clone(),
        expires: time + 60000,
      });
    },
  );
  return {
    entries,
    expire: () => {
      time += 61000;
    },
  };
}
