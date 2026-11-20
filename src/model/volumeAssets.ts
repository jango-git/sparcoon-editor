import { volumeAtlasDataUrl } from "../domain/volumeAtlas";
import type { VolumeBakeResult } from "../domain/volumeBake";
import type { MeshAsset, SourceState, VolumeAsset } from "./editorState";

/**
 * The volume asset of `baked`, baked from `mesh`. It is named after the mesh and apart from every
 * asset the library holds, since an exported effect takes all of them in one namespace.
 */
export async function volumeAssetOf(
  source: SourceState,
  mesh: MeshAsset,
  baked: VolumeBakeResult,
): Promise<VolumeAsset> {
  const taken = new Set(
    [...source.assets, ...source.meshAssets, ...source.volumeAssets].map((asset) => asset.name),
  );
  const base = `${mesh.name} SDF`;
  let name = base;
  for (let suffix = 2; taken.has(name); suffix++) {
    name = `${base} ${String(suffix)}`;
  }
  return {
    name,
    label: name,
    dataUrl: await volumeAtlasDataUrl(baked),
    size: baked.size,
    boxMin: baked.boxMin,
    boxMax: baked.boxMax,
    scale: baked.scale,
    bias: baked.bias,
  };
}
