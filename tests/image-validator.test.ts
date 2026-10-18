import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "../src/node-buffer";
import worker from "../workers/images/index";

type Info = Awaited<ReturnType<ImagesBinding["info"]>> & { frames?: number };
const valid: Info = {
  format: "image/png",
  width: 1920,
  height: 1080,
  fileSize: 12,
};
function env(info: Info = valid, outputBytes = 3) {
  let transforms = 0;
  const response = () => new Response(new Uint8Array(outputBytes));
  const transformer: ImageTransformer = {
    transform(options) {
      transforms++;
      assert.deepEqual(options, {
        width: 1920,
        height: 1080,
        fit: "scale-down",
      });
      return transformer;
    },
    draw() {
      throw Error("Unused");
    },
    async output(options) {
      assert.deepEqual(options, {
        format: "image/webp",
        quality: 88,
        anim: false,
      });
      return {
        response,
        contentType: () => "image/webp",
        image: () => response().body as ReadableStream<Uint8Array>,
      };
    },
  };
  const images: ImagesBinding = {
    async info() {
      return info;
    },
    input() {
      return transformer;
    },
    text() {
      throw Error("Unused");
    },
    get hosted(): HostedImagesBinding {
      throw Error("Unused");
    },
  };
  return { IMAGES: images, transforms: () => transforms };
}
async function request(
  bytes: Uint8Array = new Uint8Array([1, 2, 3]),
  binding = env(),
  size = String(bytes.length),
) {
  return worker.fetch(
    new Request("https://validator/", {
      method: "POST",
      headers: { "x-size": size },
      body: bytes,
    }),
    binding,
  );
}
function png(type: string, n = 0) {
  const b = Buffer.alloc(20);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  b.writeUInt32BE(n, 8);
  b.write(type, 12);
  return b;
}
function webp(type: string, n = 1, flags = 0) {
  const b = Buffer.alloc(22);
  b.write("RIFF", 0);
  b.write("WEBP", 8);
  b.write(type, 12);
  b.writeUInt32LE(n, 16);
  b[20] = flags;
  return b;
}
void test("image validator requires POST with a nonempty bounded body of the declared size", async () => {
  for (const method of ["GET", "POST"])
    assert.equal(
      (await worker.fetch(new Request("https://validator/", { method }), env()))
        .status,
      405,
    );
  for (const size of [
    "",
    "0",
    "-1",
    "1.5",
    "NaN",
    String(10 * 1024 * 1024 + 1),
    "2",
    "4",
  ]) {
    const r = await request(undefined, undefined, size);
    assert.equal(r.status, 422, size);
    assert.deepEqual(await r.json(), { error: "image_unreadable" });
  }
  assert.equal((await request()).status, 200);
});
void test("image metadata rejects unsupported formats, animation, dimensions and extreme aspect ratios", async () => {
  const invalid: Info[] = [
    { format: "image/svg+xml" },
    { ...valid, format: "gif" },
    { ...valid, width: 319 },
    { ...valid, height: 179 },
    { ...valid, width: 8193 },
    { ...valid, height: 8193 },
    { ...valid, width: 5000, height: 5000 },
    { ...valid, width: 320, height: 3000 },
    { ...valid, width: 2000, height: 180 },
    { ...valid, frames: 2 },
  ];
  for (const info of invalid) {
    const e = env(info);
    assert.equal(
      (await request(undefined, e)).status,
      422,
      JSON.stringify(info),
    );
    assert.equal(e.transforms(), 0);
  }
  for (const format of [
    "image/png",
    "image/jpeg",
    "image/webp",
    "png",
    "jpeg",
    "webp",
  ]) {
    const e = env({ ...valid, format, frames: 1 });
    const r = await request(undefined, e);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Type"), "image/webp");
    assert.equal((await r.arrayBuffer()).byteLength, 3);
    assert.equal(e.transforms(), 1);
  }
});
void test("PNG and WebP container animation and malformed chunk lengths are rejected before transcoding", async () => {
  for (const bytes of [
    png("acTL"),
    png("IDAT", 500),
    webp("ANIM"),
    webp("ANMF"),
    webp("VP8X", 1, 2),
    webp("VP8 ", 500),
  ])
    assert.equal((await request(bytes)).status, 422, bytes.toString());
  for (const bytes of [
    png("IEND"),
    webp("VP8 "),
    webp("VP8X", 1, 0),
    webp("VP8X", 0, 0).subarray(0, 20),
  ])
    assert.equal((await request(bytes)).status, 200);
});
void test("transformation failures and oversized output are reported without exposing internals", async () => {
  const e = env();
  e.IMAGES.info = async () => {
    throw Error("Secret service detail");
  };
  const r = await request(undefined, e);
  assert.equal(r.status, 422);
  assert(!JSON.stringify(await r.json()).includes("Secret"));
  assert.equal(
    (await request(undefined, env(valid, 8 * 1024 * 1024 + 1))).status,
    422,
  );
});
