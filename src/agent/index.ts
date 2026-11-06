/**
 * The programmatic editor API for agents, published as `window.sparcoon`. An agent drives a
 * (usually headless) browser on its own copy of the editor and calls this through e.g.
 * `page.evaluate`. Every input and every return value is plain JSON; errors are
 * {@link AgentError}s with the code in the message.
 *
 * This module only assembles the namespaces. Each one is built from the few services it needs,
 * and every edit goes through the editor's own model commands, so undo, autosave, recompiling
 * and the UI all follow an agent edit exactly as they follow a hand edit.
 *
 * - Top-level edits (`scene`, `graph(...)`, `timeline`) are one undo step each;
 *   `edit((transaction) => ...)` makes a whole body one step, all or nothing.
 * - A graph edit makes that graph's owner the active one, like a click on it in the editor.
 * - Reads are synchronous, except `status()`, `preview.capture*()`, `assets.add()` and the
 *   `project` loads: those wait for the editor (a recompute, a decode, a fetch) and return a
 *   Promise to await.
 */

import type { Object3D } from "three";
import type { SceneEntity } from "../model/entity";
import type { SceneCoordinator } from "../render/sceneCoordinator";
import type { Store } from "../model/store";
import type { TransportStore } from "../model/transport";
import type { GizmoSettingsStore } from "../settings/gizmoSettings";
import type { PreviewSettingsStore } from "../settings/previewSettings";
import { createAssetsApi, type AssetsApi } from "./assets";
import { createCatalogApi, type CatalogApi } from "./catalog";
import { createEditApi, type EditApi } from "./editApi";
import { createPreviewApi, type PreviewApi } from "./preview";
import { createProjectApi, type ProjectApi } from "./project";
import { readStatus } from "./status.Internal";
import { liveSession, runTransaction, stagedSession } from "./transaction.Internal";
import type { StatusView } from "./views";

export { AgentError, type AgentErrorCode } from "./errors";

/** Bumped on a breaking change to this surface. */
const AGENT_API_VERSION = 1;

export interface SparcoonAgentApi extends EditApi {
  readonly version: number;
  readonly catalog: CatalogApi;
  readonly assets: AssetsApi;
  readonly project: ProjectApi;
  readonly preview: PreviewApi;
  /** Runs `body` as one transaction: one undo step, nothing applied if it throws. Sync only. */
  edit<T>(body: (transaction: EditApi) => T): T;
  /** Returns whether there was anything to undo. */
  undo(): boolean;
  /** Returns whether there was anything to redo. */
  redo(): boolean;
  /**
   * Compile status of the active owner, or of `ownerId` after focusing it. Asynchronous on
   * purpose, unlike the other reads: it waits for the recompute the last edit scheduled, or it
   * would report the graph as it was before that edit. Await it - a pending Promise placed inside
   * a returned object serializes to `{}`.
   */
  status(ownerId?: string): Promise<StatusView>;
}

export interface AgentApiDependencies {
  readonly store: Store;
  readonly transport: TransportStore;
  readonly previewSettings: PreviewSettingsStore;
  readonly gizmoSettings: GizmoSettingsStore;
  readonly coordinator: Pick<SceneCoordinator, "advance" | "capture">;
  /** Frames an entity in the viewport (the preview's `F`). */
  readonly focusEntity: (entity: SceneEntity) => void;
  /** The live viewport object of an entity, for framing a capture on it. */
  readonly entityObject: (entity: SceneEntity) => Object3D | undefined;
}

declare global {
  interface Window {
    sparcoon?: SparcoonAgentApi;
  }
}

export function createAgentApi(dependencies: AgentApiDependencies): SparcoonAgentApi {
  const { store, transport, coordinator, focusEntity, entityObject } = dependencies;
  return {
    version: AGENT_API_VERSION,
    ...createEditApi(liveSession(store)),
    catalog: createCatalogApi(),
    assets: createAssetsApi(store),
    project: createProjectApi(dependencies),
    preview: createPreviewApi({ store, transport, coordinator, focusEntity, entityObject }),
    edit: (body) => runTransaction(store, (staging) => body(createEditApi(stagedSession(staging)))),
    undo: (): boolean => {
      const available = store.canUndo;
      store.undo();
      return available;
    },
    redo: (): boolean => {
      const available = store.canRedo;
      store.redo();
      return available;
    },
    status: (ownerId) => readStatus(store, ownerId),
  };
}

/** Builds the API and publishes it as `window.sparcoon`. */
export function installAgentApi(dependencies: AgentApiDependencies): SparcoonAgentApi {
  const api = createAgentApi(dependencies);
  window.sparcoon = api;
  return api;
}
