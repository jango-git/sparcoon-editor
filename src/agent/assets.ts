/**
 * The content library for the agent. An added file goes through the same ingestion a drop onto
 * the Content screen does (images to textures, `.hdr` to environments, `.glb`/`.gltf` to meshes),
 * so the agent hands over bytes and a file name, and nothing is decoded twice.
 */

import {
  removeEnvironmentAsset,
  removeMeshAsset,
  removeTextureAsset,
  setActiveEnvironment,
} from "../model/commands";
import type { SourceState } from "../model/editorState";
import type { Store } from "../model/store";
import { deleteEnvironmentBlob } from "../persistence/environmentBlobStore";
import { ingestFiles } from "../ui/assetIngestion";
import { AgentError } from "./errors";
import { assetsView, type AssetsView } from "./views";

export type AssetKind = "texture" | "mesh" | "environment";

/** One library entry: which library, and its name there (what nodes and `remove` refer to). */
export interface AssetReference {
  readonly kind: AssetKind;
  readonly name: string;
}

export interface AssetsApi {
  list(): AssetsView;
  /**
   * Adds a file from its bytes - a `data:` URL or bare base64 - routed by `fileName`'s extension.
   * Returns the assets it produced (a multi-mesh GLB yields one per mesh).
   */
  add(fileName: string, data: string): Promise<readonly AssetReference[]>;
  remove(kind: AssetKind, name: string): void;
  /** Lights the viewport with an environment asset; `undefined` restores the manual sun + sky. */
  setEnvironment(name: string | undefined): void;
}

/** Raster MIME types by extension; ingestion only routes `image/*` files to the texture library. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Each library's entry names, by kind. */
function libraryNames(source: SourceState): Readonly<Record<AssetKind, readonly string[]>> {
  return {
    texture: source.assets.map((asset) => asset.name),
    mesh: source.meshAssets.map((asset) => asset.name),
    environment: source.environments.map((asset) => asset.name),
  };
}

const ASSET_KINDS: readonly AssetKind[] = ["texture", "mesh", "environment"];

async function fileFrom(fileName: string, data: string): Promise<File> {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (data.startsWith("data:")) {
    const blob = await (await fetch(data)).blob();
    return new File([blob], fileName, { type: IMAGE_TYPES[extension] ?? blob.type });
  }
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new AgentError("invalid_argument", "data must be a data: URL or base64 text.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new File([bytes], fileName, { type: IMAGE_TYPES[extension] ?? "" });
}

export function createAssetsApi(store: Store): AssetsApi {
  return {
    list: () => assetsView(store.getSource()),

    add: async (fileName, data): Promise<readonly AssetReference[]> => {
      const before = libraryNames(store.getSource());
      const transfer = new DataTransfer();
      transfer.items.add(await fileFrom(fileName, data));
      await ingestFiles(transfer.files, store);
      const after = libraryNames(store.getSource());
      const added = ASSET_KINDS.flatMap((kind) =>
        after[kind].filter((name) => !before[kind].includes(name)).map((name) => ({ kind, name })),
      );
      if (added.length === 0) {
        throw new AgentError(
          "rejected",
          `"${fileName}" produced no asset (unsupported type, undecodable, or a name collision).`,
        );
      }
      return added;
    },

    remove: (kind, name): void => {
      if (!libraryNames(store.getSource())[kind].includes(name)) {
        throw new AgentError("not_found", `No ${kind} asset "${name}".`);
      }
      if (kind === "texture") {
        removeTextureAsset(store, name);
      } else if (kind === "mesh") {
        removeMeshAsset(store, name);
      } else {
        // As the Content screen's row does: the HDRI bytes also live in IndexedDB.
        removeEnvironmentAsset(store, name);
        void deleteEnvironmentBlob(name);
      }
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
  };
}
