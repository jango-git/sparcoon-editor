/**
 * The content library for the agent. An added file goes through the same ingestion a drop onto
 * the Content screen does (images to textures, `.hdr` to environments, `.glb`/`.gltf` to meshes,
 * or to scenes through the Scenes section), so the agent hands over bytes and a file name, and
 * nothing is decoded twice. A volume is baked from a mesh asset, as the Content screen's SDF baker
 * does.
 */

import {
  bakeSettingsProblem,
  bakeVolume,
  defaultBakeSettings,
  isClosedMesh,
  type VolumeBakeSettings,
} from "../domain/volumeBake";
import {
  addVolumeAsset,
  removeEnvironmentAsset,
  removeMeshAsset,
  removeSceneAsset,
  removeTextureAsset,
  removeVolumeAsset,
  setActiveEnvironment,
  setActiveScene,
} from "../model/commands";
import { isSceneName, type SourceState } from "../model/editorState";
import { libraryAssetNames } from "../model/selectors";
import type { Store } from "../model/store";
import { volumeAssetOf } from "../model/volumeAssets";
import { ingestFiles, ingestSceneFiles } from "../ui/assetIngestion";
import { base64ToBytes } from "../util/bytes";
import { AgentError } from "./errors";
import { type AssetsView, assetsView } from "./views";

export type AssetKind = "texture" | "mesh" | "environment" | "scene" | "volume";

/** A file's bytes: a `data:` URL, bare base64 text, or the raw bytes themselves. */
export type AssetData = string | Blob | ArrayBuffer | Uint8Array;

/** One library entry: which library, and its name there (what nodes and `remove` refer to). */
export interface AssetReference {
  readonly kind: AssetKind;
  readonly name: string;
}

export interface AssetsApi {
  list(): AssetsView;
  /**
   * Adds a file from its bytes, routed by `fileName`'s extension: `.png`/`.jpg`/`.jpeg`/`.webp`/
   * `.gif` to textures, `.hdr` to environments, `.glb`/`.gltf` to meshes. Returns the assets it
   * produced (a multi-mesh GLB yields one per mesh). A texture's name becomes its shader slot, so
   * it is made an identifier: extension and non-alphanumerics dropped, first letter lowercased
   * (`T_Sparkle.png` -> `tSparkle`, then `tSparkle2` on a clash). Nodes and `remove` take that
   * returned name, never the file name.
   */
  add(fileName: string, data: AssetData): Promise<readonly AssetReference[]>;
  /**
   * Adds a `.glb`, or a `.gltf` with its buffers and images embedded, to the scene library as it
   * is, and returns it. Its name is made from `fileName` as a texture's is, and never takes a
   * built-in scene's (`studio`).
   */
  addScene(fileName: string, data: AssetData): Promise<AssetReference>;
  /**
   * Bakes mesh asset `mesh` into a volume asset (an SDF) and returns it. `settings` override the
   * baker's defaults for the mesh - its bounds padded by the band, `resolution` 64 texels along the
   * longest side (4 to 128), a `band` of a tenth of its longest side, `"solid"` when it is closed
   * and `"shell"` (of `thickness`) when it is open. An SDF Sample node picking the volume takes its
   * box and distance encoding.
   */
  bakeVolume(mesh: string, settings?: Partial<VolumeBakeSettings>): Promise<AssetReference>;
  remove(kind: AssetKind, name: string): void;
  /** Lights the viewport with an environment asset; `undefined` restores the manual sun + sky. */
  setEnvironment(name: string | undefined): void;
  /** Draws a scene around the effect: `"studio"` (the ground) or a scene asset. */
  setScene(name: string): void;
}

/** Raster MIME types by extension; ingestion only routes `image/*` files to the texture library. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function libraryNames(source: SourceState): Readonly<Record<AssetKind, readonly string[]>> {
  return {
    texture: source.assets.map((asset) => asset.name),
    environment: source.environments.map((asset) => asset.name),
    scene: source.scenes.map((asset) => asset.name),
    ...libraryAssetNames(source),
  };
}

const ASSET_KINDS: readonly AssetKind[] = ["texture", "mesh", "environment", "scene", "volume"];

const REMOVE: Readonly<Record<AssetKind, (store: Store, name: string) => void>> = {
  texture: removeTextureAsset,
  mesh: removeMeshAsset,
  environment: removeEnvironmentAsset,
  scene: removeSceneAsset,
  volume: removeVolumeAsset,
};

function bakeSettings(defaults: VolumeBakeSettings, overrides: unknown): VolumeBakeSettings {
  if (overrides !== undefined && (typeof overrides !== "object" || !overrides)) {
    throw new AgentError("invalid_argument", "settings must be an object.");
  }
  const settings = { ...defaults, ...(overrides as Partial<VolumeBakeSettings> | undefined) };
  const problem = bakeSettingsProblem(settings);
  if (problem !== undefined) {
    throw new AgentError("invalid_argument", `${problem}.`);
  }
  return settings;
}

async function blobFrom(data: unknown): Promise<Blob> {
  if (data instanceof Blob) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Blob([data]);
  }
  if (data instanceof Uint8Array) {
    // A copy: a view may sit on a shared buffer, which a blob cannot take as is.
    return new Blob([data.slice()]);
  }
  if (typeof data !== "string") {
    throw new AgentError(
      "invalid_argument",
      "data must be a data: URL, base64 text, a Blob, an ArrayBuffer or a Uint8Array.",
    );
  }
  if (data.startsWith("data:")) {
    return (await fetch(data)).blob();
  }
  try {
    return new Blob([base64ToBytes(data)]);
  } catch {
    throw new AgentError(
      "invalid_argument",
      "data is a string but neither a data: URL nor base64.",
    );
  }
}

async function fileFrom(fileName: string, data: unknown): Promise<File> {
  if (typeof fileName !== "string" || fileName === "") {
    throw new AgentError("invalid_argument", "fileName must be a non-empty string.");
  }
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const blob = await blobFrom(data);
  return new File([blob], fileName, { type: IMAGE_TYPES[extension] ?? blob.type });
}

export function createAssetsApi(store: Store): AssetsApi {
  const ingest = async (
    fileName: string,
    data: AssetData,
    into: (files: FileList, store: Store) => Promise<void>,
  ): Promise<readonly AssetReference[]> => {
    const before = libraryNames(store.getSource());
    const transfer = new DataTransfer();
    transfer.items.add(await fileFrom(fileName, data));
    await into(transfer.files, store);
    const after = libraryNames(store.getSource());
    return ASSET_KINDS.flatMap((kind) =>
      after[kind].filter((name) => !before[kind].includes(name)).map((name) => ({ kind, name })),
    );
  };

  return {
    list: () => assetsView(store.getSource()),

    add: async (fileName, data): Promise<readonly AssetReference[]> => {
      const added = await ingest(fileName, data, ingestFiles);
      if (added.length === 0) {
        throw new AgentError(
          "rejected",
          `"${fileName}" produced no asset (unsupported type, undecodable, or a name collision).`,
        );
      }
      return added;
    },

    addScene: async (fileName, data): Promise<AssetReference> => {
      const [added] = await ingest(fileName, data, ingestSceneFiles);
      if (added === undefined) {
        throw new AgentError(
          "rejected",
          `"${fileName}" produced no scene (not a .glb or .gltf, or undecodable).`,
        );
      }
      return added;
    },

    bakeVolume: async (meshName, overrides): Promise<AssetReference> => {
      const mesh = store.getSource().meshAssets.find((asset) => asset.name === meshName);
      if (mesh === undefined) {
        throw new AgentError("not_found", `No mesh asset "${meshName}".`);
      }
      const defaults = defaultBakeSettings(mesh.geometry, isClosedMesh(mesh.geometry));
      const settings = bakeSettings(defaults, overrides);
      const baked = await bakeVolume(mesh.geometry, settings);
      const asset = await volumeAssetOf(store.getSource(), mesh, baked);
      addVolumeAsset(store, asset);
      return { kind: "volume", name: asset.name };
    },

    remove: (kind, name): void => {
      if (!(kind in REMOVE)) {
        throw new AgentError("invalid_argument", `kind must be one of ${ASSET_KINDS.join(", ")}.`);
      }
      if (!libraryNames(store.getSource())[kind].includes(name)) {
        throw new AgentError("not_found", `No ${kind} asset "${name}".`);
      }
      REMOVE[kind](store, name);
    },

    setEnvironment: (name): void => {
      if (
        name !== undefined &&
        !store.getSource().environments.some((asset) => asset.name === name)
      ) {
        throw new AgentError("not_found", `No environment asset "${name}".`);
      }
      setActiveEnvironment(store, name);
    },

    setScene: (name): void => {
      if (!isSceneName(name, store.getSource().scenes)) {
        throw new AgentError("not_found", `No scene "${name}".`);
      }
      setActiveScene(store, name);
    },
  };
}
