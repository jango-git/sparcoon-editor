/**
 * Content-library edits. Texture, mesh and volume edits are structural. Environment and palette
 * edits are view edits, since no compiled graph reads them.
 */

import type {
  EnvironmentAsset,
  MeshAsset,
  PaletteSwatch,
  SourceState,
  TextureAsset,
  VolumeAsset,
} from "../editorState";
import type { Store } from "../store";
import { nextIdentifier } from "./identifier";

/** Adds a texture asset. A duplicate name is a no-op. */
export function addTextureAsset(store: Store, asset: TextureAsset): void {
  const source = store.getSource();
  if (source.assets.some((existing) => existing.name === asset.name)) {
    return;
  }
  const next: SourceState = { ...source, assets: [...source.assets, asset] };
  store.commit(next, "structural");
}

/** Removes the named asset; a Texture node still referencing it falls back to a transparent texture in the preview, so a delete never has to reach across every graph. */
export function removeTextureAsset(store: Store, name: string): void {
  const source = store.getSource();
  const assets = source.assets.filter((asset) => asset.name !== name);
  if (assets.length === source.assets.length) {
    return;
  }
  store.commit({ ...source, assets }, "structural");
}

/** Adds an HDRI environment asset; a duplicate name is a no-op (see {@link addTextureAsset}). */
export function addEnvironmentAsset(store: Store, asset: EnvironmentAsset): void {
  const source = store.getSource();
  if (source.environments.some((existing) => existing.name === asset.name)) {
    return;
  }
  const next: SourceState = { ...source, environments: [...source.environments, asset] };
  store.commit(next, "view");
}

export function removeEnvironmentAsset(store: Store, name: string): void {
  const source = store.getSource();
  const environments = source.environments.filter((asset) => asset.name !== name);
  if (environments.length === source.environments.length) {
    return;
  }
  store.commit({ ...source, environments }, "view");
}

/** Sets which environment (by name) drives the viewport background/light probe, or `undefined`
 *  for manual Sun + Hemisphere lighting. */
export function setActiveEnvironment(store: Store, name: string | undefined): void {
  const source = store.getSource();
  if (source.activeEnvironmentName === name) {
    return;
  }
  store.commit({ ...source, activeEnvironmentName: name }, "view");
}

/** Adds a GLB mesh asset; a duplicate name is a no-op (see {@link addTextureAsset}). */
export function addMeshAsset(store: Store, asset: MeshAsset): void {
  const source = store.getSource();
  if (source.meshAssets.some((existing) => existing.name === asset.name)) {
    return;
  }
  const next: SourceState = { ...source, meshAssets: [...source.meshAssets, asset] };
  store.commit(next, "structural");
}

export function removeMeshAsset(store: Store, name: string): void {
  const source = store.getSource();
  const meshAssets = source.meshAssets.filter((asset) => asset.name !== name);
  if (meshAssets.length === source.meshAssets.length) {
    return;
  }
  store.commit({ ...source, meshAssets }, "structural");
}

/** Adds a volume asset. A duplicate name is a no-op (see {@link addTextureAsset}). */
export function addVolumeAsset(store: Store, asset: VolumeAsset): void {
  const source = store.getSource();
  if (source.volumeAssets.some((existing) => existing.name === asset.name)) {
    return;
  }
  store.commit({ ...source, volumeAssets: [...source.volumeAssets, asset] }, "structural");
}

export function removeVolumeAsset(store: Store, name: string): void {
  const source = store.getSource();
  const volumeAssets = source.volumeAssets.filter((asset) => asset.name !== name);
  if (volumeAssets.length === source.volumeAssets.length) {
    return;
  }
  store.commit({ ...source, volumeAssets }, "structural");
}

/** Saves a new palette swatch; unlike the other content-library kinds it has no source file to
 *  derive a key from, so its `name` is minted here (like a comment/emitter id), not by the caller. */
export function addPaletteSwatch(store: Store, color: PaletteSwatch["color"], label: string): void {
  const source = store.getSource();
  const swatch: PaletteSwatch = { name: nextIdentifier("swatch"), label, color };
  store.commit({ ...source, palette: [...source.palette, swatch] }, "view");
}

export function removePaletteSwatch(store: Store, name: string): void {
  const source = store.getSource();
  const palette = source.palette.filter((swatch) => swatch.name !== name);
  if (palette.length === source.palette.length) {
    return;
  }
  store.commit({ ...source, palette }, "view");
}
