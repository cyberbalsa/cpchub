import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/app";
import { multipart, UploadedFile, isUpload } from "../src/multipart";
import { hash } from "../src/env";
const request = (body: FormData) =>
  new Request("https://cpchub.net/upload/", { method: "POST", body });

void test("multipart streams complete and partial R2 parts, hashes bytes and preserves repeated fields", async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const size of [5 * 1024 * 1024, 5 * 1024 * 1024 + 1]) {
    const data = new FormData();
    const bytes = new Uint8Array(size).fill(3);
    data.append("file", new File([bytes], "native.cpbp"));
    for (const value of ["one", "two", "three"]) data.append("tags", value);
    const parsed = await multipart(request(data), f.env);
    assert.deepEqual(parsed.data.tags, ["one", "two", "three"]);
    assert(isUpload(parsed.data.file));
    const file = parsed.files[0]!;
    assert(file instanceof UploadedFile);
    assert.equal(file.size, size);
    assert.equal(file.digest, await hash(bytes.buffer));
    assert.deepEqual(f.objects.get(file.key), bytes);
  }
  f.sqlite.exec("DELETE FROM hub_uploadsettings");
  const raw = new Request("https://cpchub.net/", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=parts" },
    body: '--parts\r\nContent-Disposition: form-data; name="file"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n--parts--\r\n',
  });
  assert.equal((await multipart(raw, f.env)).files[0]!.name, "upload");
});

void test("multipart rejects malformed, oversized, excessive and unexpected input and removes staged objects", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await assert.rejects(
    multipart(new Request("https://cpchub.net/"), f.env),
    /Missing request body/,
  );
  f.sqlite.exec("UPDATE hub_uploadsettings SET max_file_mb=1");
  for (const kind of [
    "empty",
    "oversized",
    "truncated",
    "field",
    "files",
    "fields",
    "unexpected",
  ] as const) {
    const data = new FormData();
    data.set("image", new File(["good"], "good.png"));
    if (kind === "empty") data.set("file", new File([], "empty.cpbp"));
    if (kind === "oversized")
      data.set(
        "file",
        new File([new Uint8Array(1024 * 1024 + 1)], "large.cpbp"),
      );
    if (kind === "truncated")
      data.set(
        "screenshots",
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png"),
      );
    if (kind === "field") data.set("description", "x".repeat(25001));
    if (kind === "files")
      for (let n = 0; n < 10; n++)
        data.append("screenshots", new File(["x"], n + ".png"));
    if (kind === "fields")
      for (let n = 0; n < 31; n++) data.set("field" + n, "x");
    if (kind === "unexpected") data.set("other", new File(["x"], "other"));
    await assert.rejects(
      multipart(request(data), f.env),
      /Empty or oversized|size limit|Field too large|Too many|Unexpected/,
      kind,
    );
    assert.equal(f.objects.size, 0, kind);
  }
  const raw = new Request("https://cpchub.net/", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=parts" },
    body: '--parts\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\n\r\nx',
  });
  await assert.rejects(multipart(raw, f.env), /Malformed multipart/);
  assert.equal(f.objects.size, 0);
});

void test("R2 multipart failures abort, and abort failures do not hide the upload failure", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const original = f.env.QUARANTINE.createMultipartUpload.bind(
    f.env.QUARANTINE,
  );
  let aborted = 0;
  t.mock.method(
    f.env.QUARANTINE,
    "createMultipartUpload",
    async (key: string) => {
      const upload = await original(key);
      upload.uploadPart = async () => {
        throw Error("storage offline");
      };
      upload.abort = async () => {
        aborted++;
        throw Error("abort offline");
      };
      return upload;
    },
  );
  const data = new FormData();
  data.set("file", new File(["bytes"], "test.cpbp"));
  await assert.rejects(multipart(request(data), f.env), /Malformed multipart/);
  assert.equal(aborted, 1);
});

void test("streamed request limits stop oversized bodies without trusting Content-Length", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const prefix = new TextEncoder().encode(
    '--parts\r\nContent-Disposition: form-data; name="description"\r\n\r\n',
  );
  let count = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (!count++) c.enqueue(prefix);
      else if (count < 104) c.enqueue(new Uint8Array(1024 * 1024).fill(65));
      else c.close();
    },
  });
  const req = new Request("https://cpchub.net/", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=parts" },
    body,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(multipart(req, f.env), /Request too large/);
  assert.equal(f.objects.size, 0);
});
