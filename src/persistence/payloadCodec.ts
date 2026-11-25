/**
 * The binary payloads of a stored project - HDRI and scene files, mesh geometry - as JSON. A
 * payload is `{ encoding, data }`: `data` is base64 of the bytes as they are (`"none"`) or gzipped
 * (`"gzip"`). The project file writes `"gzip"`. The autosaved document and the format upgrades
 * write `"none"`, which is synchronous. A mesh attribute's bytes are its `Float32Array` or
 * `Uint32Array` in the platform's byte order, little-endian wherever a browser runs.
 */

import type { BakedMeshGeometry, SourceState } from "../model/editorState";
import { arrayBufferBytes, base64ToBytes, bytesToBase64, pipeBytes } from "../util/bytes";
import { isRecord } from "../util/guards";

export interface StoredPayload {
  readonly encoding: "none" | "gzip";
  readonly data: string;
}

/** Each element of an array, in a {@link PAYLOAD_PATHS} path. */
const EACH = "*";

/** Where a source holds its payloads. */
const PAYLOAD_PATHS: readonly (readonly string[])[] = [
  ["environments", EACH, "bytes"],
  ["scenes", EACH, "bytes"],
  ...(["position", "normal", "uv", "index"] satisfies (keyof BakedMeshGeometry)[]).map((key) => [
    "meshAssets",
    EACH,
    "geometry",
    key,
  ]),
];

export function isStoredPayload(raw: unknown): raw is StoredPayload {
  return (
    isRecord(raw) &&
    (raw["encoding"] === "none" || raw["encoding"] === "gzip") &&
    typeof raw["data"] === "string"
  );
}

/** The bytes of a typed array, copied out of its buffer. */
export function viewBytes(array: ArrayBufferView): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(array.byteLength);
  bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  return bytes;
}

export function plainPayload(bytes: Uint8Array): StoredPayload {
  return { encoding: "none", data: bytesToBase64(bytes) };
}

/** `bytes` gzipped. No bytes stay plain. */
async function gzipPayload(bytes: Uint8Array<ArrayBuffer>): Promise<StoredPayload> {
  if (bytes.length === 0) {
    return plainPayload(bytes);
  }
  const compressed = await pipeBytes(bytes, new CompressionStream("gzip"));
  return { encoding: "gzip", data: bytesToBase64(compressed) };
}

/**
 * The bytes `payload` holds.
 * @throws When `data` is not base64, or not gzip where the encoding says so.
 */
export async function decodePayload(payload: StoredPayload): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = base64ToBytes(payload.data);
  return payload.encoding === "gzip" ? pipeBytes(bytes, new DecompressionStream("gzip")) : bytes;
}

/** `value` with what lies at `path` replaced by `map` of it. A missing step leaves it as it is. */
function mapAt(value: unknown, path: readonly string[], map: (field: unknown) => unknown): unknown {
  const [step, ...rest] = path;
  if (step === undefined) {
    return map(value);
  }
  if (step === EACH) {
    return Array.isArray(value) ? value.map((element) => mapAt(element, rest, map)) : value;
  }
  return isRecord(value) && step in value
    ? { ...value, [step]: mapAt(value[step], rest, map) }
    : value;
}

function mapPayloads(body: unknown, map: (field: unknown) => unknown): unknown {
  return PAYLOAD_PATHS.reduce((mapped, path) => mapAt(mapped, path, map), body);
}

/** {@link mapPayloads} with an asynchronous `map`, run once for each distinct field value. */
async function mapPayloadsAsync(
  body: unknown,
  map: (field: unknown) => Promise<unknown>,
): Promise<unknown> {
  const pending = new Map<unknown, Promise<unknown>>();
  mapPayloads(body, (field) => {
    if (!pending.has(field)) {
      pending.set(field, map(field));
    }
    return field;
  });
  const done = new Map(
    await Promise.all([...pending].map(async ([field, result]) => [field, await result] as const)),
  );
  return mapPayloads(body, (field) => done.get(field));
}

/** The bytes a source field holds: a file's bytes, or a geometry attribute's copied out. */
function fieldBytes(field: unknown): Uint8Array<ArrayBuffer> {
  return (
    arrayBufferBytes(field) ?? (ArrayBuffer.isView(field) ? viewBytes(field) : new Uint8Array())
  );
}

/** `source` as a stored body with plain payloads. */
export function encodeSourcePlain(source: SourceState): unknown {
  return mapPayloads(source, (field) => plainPayload(fieldBytes(field)));
}

/** `source` as a stored body with gzipped payloads. */
export function encodeSourceCompressed(source: SourceState): Promise<unknown> {
  return mapPayloadsAsync(source, (field) => gzipPayload(fieldBytes(field)));
}

/**
 * An upgraded stored `body` with each payload decoded to its bytes. A payload that does not decode
 * becomes `undefined`, and the load drops the asset holding it. The body is untrusted.
 */
export function decodeSourcePayloads(body: unknown): Promise<unknown> {
  return mapPayloadsAsync(body, (field) =>
    isStoredPayload(field) ? decodePayload(field).catch(() => undefined) : Promise.resolve(field),
  );
}
