import type { FXCompilerError } from "../compiler/FXCompilerError";
import { isFXCompilerErrorException } from "../compiler/FXCompilerError";
import { collectReachableNodeIds } from "../compiler/FXGraphTraversal.Internal";
import { wiringFingerprint } from "../compiler/FXStructuralHash.Internal";
import { FXGraph } from "../FXGraph";
import type { FXGraphDiff } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import type { FXLiveBackend } from "./FXLiveBackend";
import type { FXGraphReconciler } from "./FXGraphReconciler";
import type { FXGraphSnapshotData } from "./FXSnapshotData";

/**
 * Outcome of applying one snapshot:
 * - `recompiled` - structure changed; a new artifact was compiled and installed.
 * - `rebound` - same structure; live values pushed into existing handles, no compile.
 * - `invalid` - graph did not validate; the last good artifact is kept running.
 */
export type FXLiveStatus = "recompiled" | "rebound" | "invalid";

/** Result of {@link FXLiveGraph.apply}. */
export interface FXLiveResult<N extends FXGraphNode = FXGraphNode> {
  readonly status: FXLiveStatus;
  readonly errors: readonly FXCompilerError[];
  readonly diff: FXGraphDiff<N>;
}

/**
 * The live-editing orchestrator: ingests editor snapshots and, per snapshot, decides via
 * the structural-hash gate whether to do nothing but push values (rebind), recompile and
 * hot-swap, or hold the last good artifact (invalid). Backend-agnostic - {@link FXLiveBackend}
 * localizes render vs. behavior.
 *
 * The rebind gate is more than a hash comparison, because the hash is content-addressed
 * (id-blind) while a rebind pushes values into specific live instances. Four conditions must
 * all hold, or a recompile runs instead:
 * (1) `previewHash` unchanged.
 * (2) The reachable id-set is exactly what the installed artifact was built over - catches
 *     a fresh add or an id-swap that leaves the hash unchanged.
 * (3) No id reachable this reconcile is in `freshIds` (never `build`-t, so it has no live
 *     handles) - catches a same-id instance replacement (delete then undo restores the id,
 *     but the instance was re-minted).
 * (4) The id-sensitive {@link wiringFingerprint} still matches - catches two structurally
 *     identical nodes trading roles, which hashes and id-sets alike cannot tell apart.
 */
export class FXLiveGraph<N extends FXGraphNode = FXGraphNode, A = unknown> {
  private readonly graph = new FXGraph<N>();
  private currentHash?: string | undefined;
  private currentArtifact?: A | undefined;
  /** Ids reachable when the current artifact was installed - see the rebind-gate conditions above. */
  private installedReachableIds: ReadonlySet<string> = new Set();
  /** Wiring fingerprint when the current artifact was installed - see the rebind-gate conditions above. */
  private installedWiring?: string | undefined;
  /** Nodes that left the graph but may still be referenced by the installed artifact. */
  private pendingDestroy: N[] = [];
  /** Set by {@link destroy}; a destroyed live graph rejects further snapshots. */
  private destroyed = false;

  constructor(
    private readonly reconciler: FXGraphReconciler<N>,
    private readonly backend: FXLiveBackend<N, A>,
  ) {}

  /** The last successfully installed artifact, or `undefined` before the first valid compile. */
  public get artifact(): A | undefined {
    return this.currentArtifact;
  }

  /**
   * The current reconciled graph - reflects the last applied snapshot. Read-only
   * use only (e.g. collecting attribute requests); the reconciler owns mutation.
   */
  public get graphView(): FXGraph<N> {
    return this.graph;
  }

  /** Applies one editor snapshot and returns what the gate decided. */
  public apply(data: FXGraphSnapshotData): FXLiveResult<N> {
    // A snapshot arriving after teardown is a natural editor race - refuse it structurally
    // rather than rebinding into destroyed handles or re-preparing over freed resources.
    if (this.destroyed) {
      return {
        status: "invalid",
        errors: [{ code: "disposed", message: "FXLiveGraph.apply: this live graph was destroyed" }],
        diff: { addedNodeIds: [], removedNodes: [] },
      };
    }
    // `apply` must never crash the editor - reconcile is result-based (never throws), and
    // the graph may be left half-mutated by a failed run; that's fine, since editor-is-master
    // means the next full snapshot re-reconciles the whole state.
    const {
      diff,
      discarded,
      freshIds,
      errors: reconcileErrors,
    } = this.reconciler.reconcile(this.graph, data);
    // Defer destroying discarded nodes: the installed artifact may still reference them,
    // so they are freed only once a newer artifact is installed (or on teardown).
    this.pendingDestroy.push(...discarded);
    if (reconcileErrors.length > 0) {
      return { status: "invalid", errors: reconcileErrors, diff };
    }

    // `validate` runs host code (the injected `buildTarget` factory) - guard it like
    // compile, folding a throw into a held `invalid`.
    let validation;
    try {
      validation = this.backend.validate(this.graph);
    } catch (error) {
      return { status: "invalid", errors: [foldThrow(error, "validate-failed")], diff };
    }
    if (!validation.ok) {
      return { status: "invalid", errors: validation.errors, diff };
    }

    // Same guard: previewHash also derives the target through host code. Its own
    // `hash-failed` code keeps this distinct from a graph-validation failure.
    let nextHash: string;
    try {
      nextHash = this.backend.previewHash(this.graph);
    } catch (error) {
      return { status: "invalid", errors: [foldThrow(error, "hash-failed")], diff };
    }
    const reachable = collectReachableNodeIds(this.graph);
    // The four rebind-gate conditions from the class doc above.
    if (
      nextHash === this.currentHash &&
      sameIdSet(reachable, this.installedReachableIds) &&
      !freshIds.some((id) => reachable.has(id)) &&
      wiringFingerprint(this.graph, reachable) === this.installedWiring
    ) {
      for (const id of reachable) {
        // A throwing third-party `syncLiveValues` aborts the rebind as a held `invalid`
        // naming the culprit. Values synced before the throw stay pushed - acceptable,
        // since the next valid snapshot re-syncs every node anyway.
        try {
          this.graph.getNode(id)?.syncLiveValues?.();
        } catch (error) {
          const foldedError = foldThrow(error, "rebind-failed");
          return {
            status: "invalid",
            errors: [
              foldedError.nodeId === undefined ? { ...foldedError, nodeId: id } : foldedError,
            ],
            diff,
          };
        }
      }
      // Safe to free deferred discards here (not just on recompile): the gate above
      // proves the reachable set is the very same instances the artifact was built
      // over, so nothing in `pendingDestroy` is among them.
      this.flushDiscarded();
      return { status: "rebound", errors: [], diff };
    }

    // A valid graph can still fail compilation (e.g. a third-party node bug). Never
    // crash the editor - hold the last good artifact and surface a synthetic error.
    // Discards stay deferred here (currentArtifact still references them).
    let nextArtifact: A;
    try {
      nextArtifact = this.backend.compile(this.graph);
      this.backend.install(nextArtifact);
    } catch (error) {
      // Poison the gate: `build` clears + re-mints each node's handles into this compile
      // context in topological order, so a node built before the throw now holds handles
      // into an aborted artifact. Clearing `currentHash` forces the next valid snapshot to
      // recompile and re-mint every handle, instead of an undo matching the stale hash and
      // rebinding into orphaned handles.
      this.currentHash = undefined;
      return { status: "invalid", errors: [foldThrow(error, "compile-failed")], diff };
    }

    this.currentArtifact = nextArtifact;
    this.currentHash = nextHash;
    this.installedReachableIds = reachable;
    this.installedWiring = wiringFingerprint(this.graph, reachable);
    // The new artifact references none of the discarded nodes - free them now.
    // Known limitation: a host may defer *mounting* the artifact past this point, so a
    // discarded node-owned texture can be disposed under a still-mounted material. Three
    // re-uploads a disposed DataTexture from CPU data, so this self-heals at a GPU-churn cost.
    this.flushDiscarded();
    return { status: "recompiled", errors: [], diff };
  }

  /** Destroys every node currently in the graph plus any deferred discards (teardown). Idempotent. */
  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.flushDiscarded();
    for (const node of this.graph.nodes.values()) {
      // Same tolerance as the flush: a throwing destructor must not abort the rest of teardown.
      try {
        node.destroy?.();
      } catch {
        // Intentionally ignored.
      }
    }
    // Release references so the destroyed nodes (their LUTs/handles) and the last
    // artifact become collectable instead of staying reachable through this graph.
    this.graph.clear();
    this.currentArtifact = undefined;
    this.currentHash = undefined;
    this.installedReachableIds = new Set();
    this.installedWiring = undefined;
  }

  private flushDiscarded(): void {
    // Take the list first, so a throwing destructor cannot leave already-destroyed
    // nodes queued for a second destroy on the next flush.
    const list = this.pendingDestroy;
    this.pendingDestroy = [];
    for (const node of list) {
      // A third-party destructor must not crash the protocol (nor abort the rest
      // of the flush) - swallow its throw; the node is dropped either way.
      try {
        node.destroy?.();
      } catch {
        // Intentionally ignored.
      }
    }
  }
}

/** Unpacks a typed throw's payload, or folds any other throw into `code`. */
function foldThrow(error: unknown, code: FXCompilerError["code"]): FXCompilerError {
  return isFXCompilerErrorException(error)
    ? error.error
    : { code, message: error instanceof Error ? error.message : String(error) };
}

/** Whether two id-sets contain exactly the same ids. */
function sameIdSet(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  if (first.size !== second.size) {
    return false;
  }
  for (const id of first) {
    if (!second.has(id)) {
      return false;
    }
  }
  return true;
}
