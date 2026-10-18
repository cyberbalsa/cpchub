import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { Buffer } from "../src/node-buffer";
import { CBOR, Reader, LIMITS, validate } from "../workers/validator/parser";
import {
  cbor,
  stream,
  blueprint,
  blueprintMetadata,
  scenario,
  roomMetadata,
} from "./helpers/native";

const parsed = (value: unknown) => new CBOR(cbor(value)).value("scalar");
const check = async (kind: string, bytes: Uint8Array, message: string) => {
  await assert.rejects(
    validate(kind, stream(bytes), bytes.length),
    new RegExp(message),
  );
};
function packed(bytes: Uint8Array) {
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(bytes.length);
  return Buffer.concat([deflateSync(bytes), tail]);
}

void test("CBOR accepts supported scalar encodings and rejects unsafe or truncated values", () => {
  for (const value of [
    true,
    false,
    null,
    -1,
    -25,
    24,
    256,
    65536,
    2n ** 40n,
    "name",
    1.25,
  ])
    assert.equal(
      parsed(value),
      typeof value === "bigint" ? Number(value) : value,
    );
  assert.equal(
    JSON.stringify(new CBOR(cbor(new Uint8Array([1, 2]))).value()),
    JSON.stringify({ type: "bytes", length: 2 }),
  );
  assert.equal(
    Object.getPrototypeOf(new CBOR(cbor({ a: 1 })).value("scalar")),
    null,
  );
  for (const [bytes, expected] of [
    [[0xf9, 0x3c, 0], 1],
    [[0xf9, 0xbc, 0], -1],
    [[0xf9, 0, 1], 2 ** -24],
    [[0xfa, 0x3f, 0x80, 0, 0], 1],
  ] as const)
    assert.equal(new CBOR(new Uint8Array(bytes)).value(), expected);
  for (const bytes of [
    [0xf9, 0x7c, 0],
    [0xf8],
    [0xff],
    [0x1c],
    [0xc0],
    [0x81],
    [0x63, 65],
    [0xa1, 0xf6, 0],
    [0xa1, 0xf4, 0],
  ])
    assert.throws(
      () => new CBOR(new Uint8Array(bytes)).value(),
      /invalid_metadata/,
    );
  assert.throws(() => parsed(2n ** 63n), /invalid_metadata/);
  for (const length of [-1, NaN, 1.5, 10])
    assert.throws(
      () => new CBOR(new Uint8Array(1)).take(length),
      /invalid_metadata/,
    );
  const p = new CBOR(cbor(0));
  p.nodes = LIMITS.nodes;
  assert.throws(() => p.value(), /metadata_values_limit/);
  const huge = Buffer.from([0x9a, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => new CBOR(huge).value(), /metadata_values_limit/);
  assert.equal(
    JSON.stringify(new CBOR(cbor("ignored")).value()),
    JSON.stringify({ type: "string", length: 0 }),
  );
});

void test("stream reader enforces bounds across initial chunks and draining", async () => {
  const reader = new Reader(stream(new Uint8Array([1, 2, 3, 4]), 1), 4);
  assert.deepEqual(await reader.take(2), new Uint8Array([1, 2]));
  assert.equal(await reader.drain(), 4);
  for (const n of [-1, 5])
    await assert.rejects(
      new Reader(stream(new Uint8Array()), 4).take(n),
      /expanded_size_limit/,
    );
  await assert.rejects(
    new Reader(stream(new Uint8Array()), 4).take(1),
    /scenario_length/,
  );
  await assert.rejects(
    new Reader(stream(new Uint8Array(5), 5), 4).take(1),
    /expanded_size_limit/,
  );
  await assert.rejects(
    new Reader(stream(new Uint8Array(5), 1), 4).drain(),
    /expanded_size_limit/,
  );
});

void test("blueprints reject malformed metadata, dimensions and unsupported versions", async () => {
  for (const length of [0, -1, NaN, 1.5, LIMITS.input + 1])
    await assert.rejects(
      validate("blueprint", stream(new Uint8Array()), length),
      /invalid_file/,
    );
  await check("other", blueprint(), "invalid_file");
  await check("blueprint", blueprint(undefined, 1), "blueprint_version");
  for (const metadata of [
    0,
    [],
    true,
    { ...blueprintMetadata(), name: null },
    { ...blueprintMetadata(), placedTemplates: [] },
  ])
    await check(
      "blueprint",
      blueprint(metadata),
      "invalid_metadata|blueprint_metadata",
    );
  for (const size of [
    null,
    [1, 1],
    ["1", 1, 1],
    [1, "1", 1],
    [1, 1, "1"],
    [0, 1, 1],
    [1.2, 1, 1],
    [2049, 1, 1],
  ])
    await check(
      "blueprint",
      blueprint({ ...blueprintMetadata(), size }),
      "invalid_dimensions",
    );
  await check(
    "blueprint",
    blueprint({ ...blueprintMetadata(), size: [2, 1, 1] }),
    "blueprint_metadata",
  );
  await check(
    "blueprint",
    blueprint({ ...blueprintMetadata(), tileMapSize: [2048, 2048, 2048] }),
    "expanded_size_limit",
  );
  await check(
    "blueprint",
    blueprint({ ...blueprintMetadata(), tileMapSize: [1024, 64, 1024] }),
    "expanded_size_limit",
  );
  const extra = blueprint();
  extra.writeUInt32LE(extra.readUInt32LE(4) + 1, 4);
  await check("blueprint", extra, "invalid_metadata");
  const truncated = blueprint().subarray(0, -1);
  await assert.rejects(
    validate("blueprint", stream(truncated), truncated.length + 1),
    /blueprint_length/,
  );
  const zero = Buffer.alloc(8);
  zero.writeUInt32LE(3);
  await check("blueprint", zero, "metadata_size_limit");
});

void test("blueprint statistics count placement types and safely mark unknown shapes", async () => {
  const metadata = {
    ...blueprintMetadata(),
    ignored: "ignored",
    placedTemplates: {
      GolfCartBay: [0, 1],
      ParkingEntrance: [null],
      ParkingExit: [false],
      empty: [],
    },
  };
  const bytes = blueprint(metadata, 2);
  const result = await validate("blueprint", stream(bytes), bytes.length);
  assert.equal(result.objects, 4);
  assert.equal(result.object_types, 3);
  assert.equal(result.parking_spaces, 0);
  assert.equal(result.golf_cart_spaces, 2);
  assert.equal(result.entrances, 1);
  assert.equal(result.exits, 1);
  for (const placedTemplates of [{ bad: 1 }, new Map([[1, []]]), { bad: {} }]) {
    const unknown = blueprint({ ...blueprintMetadata(), placedTemplates });
    const stats = await validate("blueprint", stream(unknown), unknown.length);
    for (const value of [
      stats.objects,
      stats.object_types,
      stats.parking_spaces,
      stats.golf_cart_spaces,
      stats.entrances,
      stats.exits,
    ])
      assert.equal(value, null);
  }
});

void test("scenario metadata and room counts fail before reading unbounded world data", async () => {
  for (const rooms of [
    undefined,
    null,
    [],
    Array.from({ length: 17 }, roomMetadata),
  ])
    await check(
      "scenario",
      scenario(rooms === undefined ? {} : { rooms }),
      "scenario_rooms",
    );
  for (const room of [
    null,
    [],
    { ...roomMetadata(), entities: null },
    { ...roomMetadata(), scenario: 1 },
    { ...roomMetadata(), scenario: "bad" },
  ])
    await check("scenario", scenario({ rooms: [room] }), "scenario_metadata");
  await check(
    "scenario",
    scenario({ rooms: [{ ...roomMetadata(), tileMapSize: [1024, 64, 1024] }] }),
    "expanded_size_limit",
  );
  for (const n of [0, LIMITS.metadata + 1]) {
    const head = Buffer.alloc(8);
    head.writeBigUInt64LE(BigInt(n));
    await check("scenario", packed(head), "metadata_size_limit");
  }
  await check("scenario", scenario(undefined, 14), "scenario_length");
  const valid = scenario();
  await assert.rejects(
    validate("scenario", stream(valid, 1), valid.length - 1),
    /scenario_length/,
  );
  await assert.rejects(
    validate("scenario", stream(valid, 1), valid.length + 1),
    /scenario_trailer/,
  );
  await check("scenario", new Uint8Array([1, 2, 3]), "scenario_trailer");
});

void test("scenario entity projections support maps, arrays and unknown components without guessing counts", async () => {
  const entity = {
    template: "ParkingBay",
    components: { Placed: {}, Ignored: [] },
    ignored: 0,
  };
  const rooms = [
    {
      ...roomMetadata(),
      entities: { a: entity, b: entity },
      ignored: true,
      scenario: [],
    },
    {
      ...roomMetadata(),
      entities: [entity, {}, { template: "other", components: {} }],
    },
  ];
  const bytes = scenario({ rooms }, 30);
  const result = await validate("scenario", stream(bytes), bytes.length);
  assert.equal(result.entities, 5);
  assert.equal(result.maps, 2);
  assert.equal(result.parking_spaces, 3);
  for (const bad of [
    null,
    [],
    { components: [] },
    { components: { Placed: {} }, template: 1 },
  ]) {
    const bytes = scenario(
      { rooms: [{ ...roomMetadata(), entities: [bad] }, roomMetadata()] },
      30,
    );
    const result = await validate("scenario", stream(bytes), bytes.length);
    assert.equal(result.objects, null);
  }
  const bytes2 = scenario({
    rooms: [{ ...roomMetadata(), entities: { bad: false } }],
  });
  assert.equal(
    (await validate("scenario", stream(bytes2), bytes2.length)).objects,
    null,
  );
});
