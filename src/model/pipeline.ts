/**
 * The source -> derived recompute, coalesced to at most once per frame. Hands the scene to a
 * {@link SceneApplier} (the render layer), which drives one runtime emitter/mesh per doc and reports back snapshots + live-apply status.
 */

import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { EditorAttribute } from "../domain/graphModel";
import type { RenderSinkConfig, SpawnSinkConfig } from "../domain/nodePalette";
import type { LiveApplyStatus, SceneModel } from "./editorState";
import type { Store } from "./store";

/** Per-graph outcome of one apply: the render and behavior live-apply statuses. */
export interface GraphApplyResult {
  readonly render: LiveApplyStatus;
  readonly behavior: LiveApplyStatus;
  /**
   * Whether this apply tore down and rebuilt the runtime emitter (fresh `FXEmitter.fromArtifacts`)
   * vs a rebind or render-only in-place swap - `render`/`behavior` alone conflate "artifact
   * changed" with "playback was reset", which a render-only swap decouples.
   */
  readonly emitterRebuilt: boolean;
}

/**
 * The library-driving boundary for one emitter: its two graphs compile into one coupled artifact
 * pair (attributes merge across them), so they apply together in a single call.
 */
export interface GraphApplier {
  apply(
    renderSnapshot: FXGraphSnapshotData,
    behaviorSnapshot: FXGraphSnapshotData,
    config: RenderSinkConfig,
    spawnConfig: SpawnSinkConfig,
    declaredAttributes: readonly EditorAttribute[],
  ): GraphApplyResult;
}

/** What one scene-sync produced: everything the derived state (and the UI) needs. */
export interface SceneApplyResult {
  readonly renderSnapshot: FXGraphSnapshotData;
  readonly behaviorSnapshot: FXGraphSnapshotData;
  readonly renderStatus: LiveApplyStatus;
  readonly behaviorStatus: LiveApplyStatus;
  /**
   * An emitter's own `GraphApplyResult.emitterRebuilt` (absent for a mesh, which has no
   * render-only-swap path). Folded into `recompiled` below, not a signal consumers need on its own.
   */
  readonly emitterRebuilt?: boolean;
  /**
   * Whether this sync genuinely rebuilt an emitter/mesh (vs a value-only rebind); consumers use
   * it to restart the timeline only on a real rebuild. Absent means false.
   */
  readonly recompiled?: boolean;
}

/**
 * The scene-driving boundary: reconciles runtime emitters/meshes (one per doc), applies each
 * doc's graphs, and returns the active graph owner's snapshots + status for the graph panel.
 */
export interface SceneApplier {
  sync(scene: SceneModel): SceneApplyResult;
}

export class Pipeline {
  private frameHandle: number | undefined = undefined;

  constructor(
    private readonly store: Store,
    private readonly applier: SceneApplier,
    // Fired after a recompute that genuinely rebuilt an emitter/mesh (not a value-only rebind), so
    // the caller can restart the timeline only on a real rebuild. Omitted in tests.
    private readonly onRecompiled: () => void = () => {},
  ) {}

  /** Requests a recompute on the next frame, coalescing repeated calls. */
  public scheduleRecompute(): void {
    if (this.frameHandle !== undefined) {
      return;
    }
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = undefined;
      this.recomputeNow();
    });
  }

  /** Runs the recompute immediately (e.g. on initial load). */
  public recomputeNow(): void {
    const result = this.applier.sync(this.store.getSource().scene);
    this.store.setDerived({
      renderSnapshot: result.renderSnapshot,
      behaviorSnapshot: result.behaviorSnapshot,
      renderStatus: result.renderStatus,
      behaviorStatus: result.behaviorStatus,
    });
    if (result.recompiled === true) {
      this.onRecompiled();
    }
  }
}
