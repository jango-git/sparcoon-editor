/**
 * The source -> derived recompute, coalesced to at most once per frame. Hands the scene to a
 * {@link SceneApplier} (the render layer), which drives one runtime emitter/mesh per doc and reports back snapshots + live-apply status.
 */

import type { EditorAttribute } from "../domain/graphModel";
import type { RenderSinkConfig, SpawnSinkConfig, StripSinkConfigs } from "../domain/nodePalette";
import type { FXGraphSnapshotData } from "../engine/core/live/FXSnapshotData";
import type { DerivedState, LiveApplyStatus, SceneModel } from "./editorState";
import { STRIP_NAMES, type StripName } from "./graphSlots";
import type { Store } from "./store";

/** Per-graph outcome of one apply: the render and behavior live-apply statuses, and each strip's
 *  (absent when the emitter has no such strip). */
export type GraphApplyResult = {
  readonly render: LiveApplyStatus;
  readonly behavior: LiveApplyStatus;
} & { readonly [K in StripName]?: LiveApplyStatus } & {
  /**
   * Whether this apply tore down and rebuilt the runtime emitter (fresh `FXEmitter.fromArtifacts`)
   * vs a rebind or render-only in-place swap - `render`/`behavior` alone conflate "artifact
   * changed" with "playback was reset", which a render-only swap decouples.
   */
  readonly emitterRebuilt: boolean;
};

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
    strips?: StripApplyInputs,
  ): GraphApplyResult;
}

/** An emitter's strip graph as one apply takes it. */
export interface StripApplyInput<K extends StripName = StripName> {
  readonly snapshot: FXGraphSnapshotData;
  readonly config: StripSinkConfigs[K];
}

/** An emitter's trail graph as one apply takes it; omitted when the emitter has no trail. */
export type TrailApplyInput = StripApplyInput<"trail">;

/** Every strip graph an emitter has, by name; a strip it does not have is omitted. */
export type StripApplyInputs = { readonly [K in StripName]?: StripApplyInput<K> };

/** One strip graph's part of a scene sync. */
export interface StripApplyOutcome {
  readonly snapshot: FXGraphSnapshotData;
  readonly status: LiveApplyStatus;
}

/** What one scene-sync produced: everything the derived state (and the UI) needs. */
export interface SceneApplyResult {
  readonly renderSnapshot: FXGraphSnapshotData;
  readonly behaviorSnapshot: FXGraphSnapshotData;
  readonly renderStatus: LiveApplyStatus;
  readonly behaviorStatus: LiveApplyStatus;
  /** The active emitter's strip graphs and their statuses; a strip it has not is absent. */
  readonly strips?: { readonly [K in StripName]?: StripApplyOutcome };
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
    const derived: Partial<DerivedState> = {
      renderSnapshot: result.renderSnapshot,
      behaviorSnapshot: result.behaviorSnapshot,
      renderStatus: result.renderStatus,
      behaviorStatus: result.behaviorStatus,
    };
    // Every strip's written, absent ones as undefined: setDerived patches, so an omitted key would
    // keep a stale strip.
    for (const name of STRIP_NAMES) {
      const strip = result.strips?.[name];
      derived[`${name}Snapshot`] = strip?.snapshot;
      derived[`${name}Status`] = strip?.status;
    }
    this.store.setDerived(derived);
    if (result.recompiled === true) {
      this.onRecompiled();
    }
  }
}
