/**
 * Picking a volume asset also sets the node inputs of the same names (box and distance encoding),
 * so the node reads the volume as baked.
 */

import type { GraphNode } from "../domain/graphModel";
import { type GraphKind, metaFor } from "../domain/nodePalette";
import { assetParamsOf } from "../engine/core/nodes/FXAssetKind";
import { type SourceState, VOLUME_DESCRIPTION_KEYS } from "./editorState";

/** The inputs of `node` that the volume assets `patch` picks describe, as a parameter patch. */
export function volumeDescriptionPatch(
  source: SourceState,
  kind: GraphKind,
  node: GraphNode,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const metadata = metaFor(kind, node.type);
  if (metadata === undefined) {
    return {};
  }
  const inputs = new Set(metadata.inputs.map((input) => input.key));
  const described: Record<string, unknown> = {};
  for (const { key, kind } of assetParamsOf(metadata)) {
    if (kind !== "volume" || !(key in patch)) {
      continue;
    }
    const asset = source.volumeAssets.find((volume) => volume.name === patch[key]);
    if (asset === undefined) {
      continue;
    }
    for (const key of VOLUME_DESCRIPTION_KEYS) {
      if (inputs.has(key)) {
        const value = asset[key];
        described[key] = typeof value === "number" ? value : [...value];
      }
    }
  }
  return described;
}
