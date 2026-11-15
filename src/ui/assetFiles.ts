/**
 * The content library's assets as files, the way they leave the editor - one asset from its row, or
 * the library as a zip. A file is named after the asset's label, as the library shows it.
 */

import type {
  EnvironmentAsset,
  MeshAsset,
  SourceState,
  TextureAsset,
  VolumeAsset,
} from "../model/editorState";
import { encodeMeshGlb } from "../render/meshGeometryBaking";
import { dataUrlBytes } from "../util/bytes";
import { writeZip, type ZipEntry } from "../util/zip";

/** One asset as a file. */
export interface AssetFile {
  readonly fileName: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** An image or an HDRI: the uploaded file, under its own name. */
export function uploadedFile(asset: TextureAsset | EnvironmentAsset): AssetFile {
  return { fileName: asset.label, bytes: dataUrlBytes(asset.dataUrl) };
}

export async function meshFile(asset: MeshAsset): Promise<AssetFile> {
  return {
    fileName: `${asset.label}.glb`,
    bytes: new Uint8Array(await encodeMeshGlb(asset.geometry)),
  };
}

/** The PNG of its slices, with the size the texture is built at in the name. */
export function volumeFile(asset: VolumeAsset): AssetFile {
  return {
    fileName: `${asset.label} ${asset.size.join("x")}.png`,
    bytes: dataUrlBytes(asset.dataUrl),
  };
}

/**
 * `fileName` with ` 2`, ` 3` and so on before its extension until `taken` has no such name. `taken`
 * holds lowercase names: a file system that ignores case would merge `Cube.glb` and `cube.glb`.
 */
function uniqueFileName(fileName: string, taken: ReadonlySet<string>): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  let candidate = fileName;
  for (let copy = 2; taken.has(candidate.toLowerCase()); copy++) {
    candidate = `${stem} ${String(copy)}${extension}`;
  }
  return candidate;
}

/**
 * A zip of the images, meshes and volumes of the library, side by side. HDRIs only light the
 * preview, so they stay out. Two assets with one label get files told apart by a number.
 */
export async function libraryZip(source: SourceState): Promise<Uint8Array<ArrayBuffer>> {
  // An image is compressed already, a GLB is not.
  const files = [
    ...source.assets.map((asset) => ({ file: uploadedFile(asset), deflate: false })),
    ...(await Promise.all(
      source.meshAssets.map(async (asset) => ({ file: await meshFile(asset), deflate: true })),
    )),
    ...source.volumeAssets.map((asset) => ({ file: volumeFile(asset), deflate: false })),
  ];
  const taken = new Set<string>();
  const entries = files.map(({ file, deflate }): ZipEntry => {
    const name = uniqueFileName(file.fileName, taken);
    taken.add(name.toLowerCase());
    return { name, bytes: file.bytes, deflate };
  });
  return writeZip(entries);
}
