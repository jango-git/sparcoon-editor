/**
 * Reads dropped/picked files and routes each to its library (image/HDRI/mesh), baking uploaded
 * bytes into the shapes the content library stores (ADR-0001/ADR-0003).
 */

import { Mesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { addEnvironmentAsset, addMeshAsset, addTextureAsset } from "../model/commands";
import type { MeshAsset } from "../model/editorState";
import { putEnvironmentBlob } from "../persistence/environmentBlobStore";
import { bakeGeometryArrays } from "../render/meshGeometryBaking";
import { selectEnvironmentAssets, selectMeshAssets, selectTextureAssets } from "../model/selectors";
import type { Store } from "../model/store";

/** Loaded image bytes plus intrinsic size - everything a texture asset needs beyond its name. */
interface LoadedImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** A file routed to the HDRI library by extension, and to the mesh library likewise. */
export const HDRI_EXTENSIONS = [".hdr"];
export const MESH_EXTENSIONS = [".glb", ".gltf"];

/**
 * Reads dropped/picked files and routes each to its library. Extension wins over MIME: some browsers
 * report `.hdr` as `image/*`, but it is not an `<img>`-decodable raster, so it must reach the HDRI
 * library, not the texture one. Only genuine rasters fall through to the image branch.
 */
export async function ingestFiles(files: FileList | undefined, store: Store): Promise<void> {
  if (files === undefined) {
    return;
  }
  for (const file of Array.from(files)) {
    try {
      if (hasExtension(file.name, HDRI_EXTENSIONS)) {
        await ingestEnvironment(file, store);
      } else if (hasExtension(file.name, MESH_EXTENSIONS)) {
        await ingestMesh(file, store);
      } else if (file.type.startsWith("image/")) {
        await ingestImage(file, store);
      }
    } catch (error) {
      console.warn(`Failed to load asset "${file.name}"`, error);
    }
  }
}

async function ingestImage(file: File, store: Store): Promise<void> {
  const image = await loadImage(file);
  const existing = selectTextureAssets(store).map((asset) => asset.name);
  addTextureAsset(store, {
    name: uniqueAssetName(file.name, existing),
    label: file.name,
    dataUrl: image.dataUrl,
    width: image.width,
    height: image.height,
  });
}

async function ingestEnvironment(file: File, store: Store): Promise<void> {
  const dataUrl = await readDataUrl(file);
  const existing = selectEnvironmentAssets(store).map((asset) => asset.name);
  const name = uniqueAssetName(file.name, existing);
  // The live document keeps `dataUrl` in memory for this session, but only IndexedDB persists it
  // across reload - autosave strips it before writing to localStorage (see localStore.ts).
  await putEnvironmentBlob(name, dataUrl);
  addEnvironmentAsset(store, { name, label: file.name, dataUrl, byteSize: file.size });
}

/** Four bytes per component (Float32/Uint32) - an honest size for what is actually stored,
 *  not the (discarded) original upload's byte count. */
function bakedByteSize(geometry: MeshAsset["geometry"]): number {
  return (
    (geometry.position.length +
      geometry.normal.length +
      geometry.uv.length +
      geometry.index.length) *
    4
  );
}

/**
 * Parses an uploaded GLB/GLTF via `GLTFLoader`, bakes every mesh it contains into its own
 * independent {@link MeshAsset} (ADR-0001), decomposing a multi-mesh file into N assets
 * (ADR-0003). Named from the GLTF mesh/node name when present and not already taken, otherwise
 * `<file name> #<N>` (1-based, in file order); a name that collides even after the fallback drops
 * just that one mesh, not the whole batch.
 */
async function ingestMesh(file: File, store: Store): Promise<void> {
  const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), "");
  const meshes: Mesh[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) {
      meshes.push(object);
    }
  });

  const taken = new Set(selectMeshAssets(store).map((asset) => asset.name));
  meshes.forEach((mesh, index) => {
    const candidate = mesh.name.trim() !== "" ? mesh.name.trim() : "";
    const name =
      candidate !== "" && !taken.has(candidate) ? candidate : `${file.name} #${String(index + 1)}`;
    if (taken.has(name)) {
      console.warn(`Skipped mesh "${name}" from "${file.name}": name already taken`);
      return;
    }
    taken.add(name);
    const geometry = bakeGeometryArrays(mesh.geometry);
    addMeshAsset(store, { name, label: name, geometry, byteSize: bakedByteSize(geometry) });
  });
}

function hasExtension(fileName: string, extensions: readonly string[]): boolean {
  const lower = fileName.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

/** Reads a file to a base64 data URL. */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = (): void => reject(reader.error ?? new Error("read failed"));
    reader.onload = (): void => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

/** Reads a file to a base64 data URL and decodes its intrinsic dimensions. */
async function loadImage(file: File): Promise<LoadedImage> {
  const dataUrl = await readDataUrl(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = (): void => reject(new Error("decode failed"));
    image.onload = (): void =>
      resolve({ dataUrl, width: image.naturalWidth, height: image.naturalHeight });
    image.src = dataUrl;
  });
}

/**
 * Derives a valid, unique asset name (`^[a-z][A-Za-z0-9]*`) from a file name: strips the extension
 * and any non-alphanumeric characters, lowercases the first letter, and falls back to `texture` when
 * nothing usable remains. A collision is resolved by a numeric suffix so a second `spark.png` becomes
 * `spark2`. Textures need this because it derives their uniform slot; the other kinds only need a
 * unique key, and share the same rule for consistency.
 */
function uniqueAssetName(fileName: string, existing: readonly string[]): string {
  const base = fileName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]/g, "");
  const sanitized = /^[a-z]/.test(base)
    ? base
    : /^[A-Za-z]/.test(base)
      ? base.charAt(0).toLowerCase() + base.slice(1)
      : `texture${base}`;
  const taken = new Set(existing);
  if (!taken.has(sanitized)) {
    return sanitized;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${sanitized}${index.toString()}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
