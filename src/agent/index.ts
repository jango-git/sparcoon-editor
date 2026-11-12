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
 * - `arrange()` lays a graph out from its cards on the live canvas, so it shows that graph.
 * - Reads are synchronous, except `status()`, `preview.capture*()`, `assets.add()` and the
 *   `project` loads: those wait for the editor (a recompute, a decode, a fetch) and return a
 *   Promise to await.
 */

import type { Object3D } from "three";

import type { SceneEntity } from "../model/entity";
import type { GraphName } from "../model/graphSlots";
import type { Store } from "../model/store";
import type { TransportStore } from "../model/transport";
import type { SceneCoordinator } from "../render/sceneCoordinator";
import type { GizmoSettingsStore } from "../settings/gizmoSettings";
import type { PreviewSettingsStore } from "../settings/previewSettings";
import { arrangeOwnerGraph } from "./arrange.Internal";
import { type AssetsApi, createAssetsApi } from "./assets";
import { type CatalogApi, createCatalogApi } from "./catalog";
import { createEditApi, type EditApi } from "./editApi";
import { createPreviewApi, type PreviewApi } from "./preview";
import { createProjectApi, type ProjectApi } from "./project";
import { readStatus } from "./status.Internal";
import { liveSession, runTransaction, stagedSession } from "./transaction.Internal";
import type { StatusView } from "./views";

export { AgentError, type AgentErrorCode } from "./errors";

/** Bumped on a breaking change to this surface. */
// 2: setting a key on a frame that already holds one is refused unless asked to replace it.
const AGENT_API_VERSION = 2;

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
   * a returned object serializes to `{}`. A VFX mesh reports no `behavior` (it has no such graph).
   */
  status(ownerId?: string): Promise<StatusView>;
  /**
   * Auto-arranges `ownerId`'s `graph`, as the graph's Arrange button does: columns from inputs to
   * the sinks, every wire at right angles (routes rebuilt), comments dropped. One undo step. It
   * lays the graph out from its cards as drawn, so the editor shows that graph afterwards; not
   * available inside `edit()`.
   */
  arrange(ownerId: string, graph: string): void;
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
  /** Shows the active owner's graph `name` and auto-arranges it (the graph's Arrange button). */
  readonly arrangeGraph: (name: GraphName) => void;
}

declare global {
  interface Window {
    sparcoon?: SparcoonAgentApi;
  }
}

export function createAgentApi(dependencies: AgentApiDependencies): SparcoonAgentApi {
  const { store, transport, coordinator, focusEntity, entityObject, arrangeGraph } = dependencies;
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
    arrange: (ownerId, graph) => arrangeOwnerGraph(store, arrangeGraph, ownerId, graph),
  };
}

/** Builds the API and publishes it as `window.sparcoon`. */
export function installAgentApi(dependencies: AgentApiDependencies): SparcoonAgentApi {
  const api = createAgentApi(dependencies);
  window.sparcoon = api;
  return api;
}
