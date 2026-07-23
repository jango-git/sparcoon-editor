/**
 * Content-library edits (textures/environments/meshes), each its own array + command pair. Texture/
 * mesh edits are `"structural"` (they rebind preview slots); environment edits are `"view"` (ADR-0004: no compiled graph reads them).
 */

import type { EnvironmentAsset, MeshAsset, SourceState, TextureAsset } from "../editorState";
import type { Store } from "../store";

/** Adds a texture asset. `name` is expected already unique (see {@link uniqueAssetName}); a duplicate is a no-op so a double-fire can't shadow an existing asset. */
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

/** Removes the named HDRI environment asset from the library. */
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

/** Removes the named GLB mesh asset from the library. */
export function removeMeshAsset(store: Store, name: string): void {
  const source = store.getSource();
  const meshAssets = source.meshAssets.filter((asset) => asset.name !== name);
  if (meshAssets.length === source.meshAssets.length) {
    return;
  }
  store.commit({ ...source, meshAssets }, "structural");
}
