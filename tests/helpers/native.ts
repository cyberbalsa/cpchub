import { Buffer } from "../../src/node-buffer";
import { deflateSync } from "node:zlib";

function header(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([major * 32 + n]);
  if (n <= 255) return Buffer.from([major * 32 + 24, n]);
  const result = Buffer.alloc(n <= 65535 ? 3 : 5);
  result[0] = major * 32 + (n <= 65535 ? 25 : 26);
  if (n <= 65535) result.writeUInt16BE(n, 1);
  else result.writeUInt32BE(n, 1);
  return result;
}
export function cbor(value: unknown): Buffer {
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === "boolean") return Buffer.from([value ? 0xf5 : 0xf4]);
  if (typeof value === "number") {
    if (Number.isSafeInteger(value))
      return header(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
    const result = Buffer.alloc(9);
    result[0] = 0xfb;
    result.writeDoubleBE(value, 1);
    return result;
  }
  if (typeof value === "bigint") {
    const result = Buffer.alloc(9);
    result[0] = 0x1b;
    result.writeBigUInt64BE(value, 1);
    return result;
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([header(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array)
    return Buffer.concat([header(2, value.length), value]);
  if (Array.isArray(value))
    return Buffer.concat([
      header(4, value.length),
      ...(value as unknown[]).map(cbor),
    ]);
  if (typeof value !== "object") throw new Error("Unsupported test CBOR value");
  const entries =
    value instanceof Map
      ? ([...value.entries()] as [unknown, unknown][])
      : Object.entries(value);
  return Buffer.concat([
    header(5, entries.length),
    ...entries.flatMap(([key, v]) => [cbor(key), cbor(v)]),
  ]);
}
export function stream(
  bytes: Uint8Array,
  chunk = 7,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunk)
        controller.enqueue(bytes.subarray(at, at + chunk));
      controller.close();
    },
  });
}
export const blueprintMetadata = () => ({
  name: "Test",
  size: [1, 1, 1],
  tileMapSize: [1, 1, 1],
  placedTemplates: { ParkingBay: [{}] },
});
export const roomMetadata = () => ({
  tileMapSize: [1, 1, 1],
  scenario: {},
  entities: [{ template: "ParkingBay", components: { Placed: {} } }],
});
export function blueprint(
  metadata: unknown = blueprintMetadata(),
  version = 3,
  bodyLength = 6,
): Buffer {
  const bytes = cbor(metadata),
    head = Buffer.alloc(8);
  head.writeUInt32LE(version);
  head.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([head, bytes, Buffer.alloc(bodyLength)]);
}
export function scenario(
  metadata: unknown = { rooms: [roomMetadata()] },
  bodyLength = 15,
): Buffer {
  const bytes = cbor(metadata),
    head = Buffer.alloc(8);
  head.writeBigUInt64LE(BigInt(bytes.length));
  const expanded = Buffer.concat([head, bytes, Buffer.alloc(bodyLength)]),
    tail = Buffer.alloc(4);
  tail.writeUInt32LE(expanded.length);
  return Buffer.concat([deflateSync(expanded), tail]);
}
