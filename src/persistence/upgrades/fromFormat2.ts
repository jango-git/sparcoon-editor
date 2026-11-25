/**
 * Format 2 -> 3: binary payloads as `{ encoding, data }` (see `payloadCodec.ts`) in place of
 * text and number arrays.
 *
 * - An HDRI's `dataUrl` becomes its `bytes`: the base64 the data URL carries, stored plain. An
 *   emptied one (the autosaved document keeps its payload in IndexedDB) becomes an empty payload.
 * - A mesh asset's `geometry` arrays become the bytes of a `Float32Array` (`position`, `normal`,
 *   `uv`) or a `Uint32Array` (`index`). An element that is not a finite number reads as 0. A
 *   field that already holds a payload (a later file read as this format) is kept.
 *
 * The body is untrusted: what is not shaped as format 2 is passed through for the load to defend.
 */

import { dataUrlBase64 } from "../../util/bytes";
import { isRecord } from "../../util/guards";
import { isStoredPayload, plainPayload, viewBytes } from "../payloadCodec";
import type { ProjectUpgrade } from "../projectEnvelope";

function upgradeEnvironment(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }
  const { dataUrl, ...rest } = raw;
  const data =
    dataUrl === "" ? "" : typeof dataUrl === "string" ? dataUrlBase64(dataUrl) : undefined;
  return data === undefined ? rest : { ...rest, bytes: { encoding: "none", data } };
}

function arrayPayload(
  raw: unknown,
  arrayType: Float32ArrayConstructor | Uint32ArrayConstructor,
): unknown {
  if (isStoredPayload(raw)) {
    return raw;
  }
  const numbers = Array.isArray(raw)
    ? raw.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0))
    : [];
  return plainPayload(viewBytes(arrayType.from(numbers)));
}

function upgradeMeshAsset(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw["geometry"])) {
    return raw;
  }
  const { position, normal, uv, index } = raw["geometry"];
  return {
    ...raw,
    geometry: {
      position: arrayPayload(position, Float32Array),
      normal: arrayPayload(normal, Float32Array),
      uv: arrayPayload(uv, Float32Array),
      index: arrayPayload(index, Uint32Array),
    },
  };
}

export const upgradeFromFormat2: ProjectUpgrade = (body) => {
  if (!isRecord(body)) {
    return body;
  }
  const environments = body["environments"];
  const meshAssets = body["meshAssets"];
  return {
    ...body,
    ...(Array.isArray(environments) ? { environments: environments.map(upgradeEnvironment) } : {}),
    ...(Array.isArray(meshAssets) ? { meshAssets: meshAssets.map(upgradeMeshAsset) } : {}),
  };
};
