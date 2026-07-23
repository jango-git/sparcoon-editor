import type { FXCompilerError } from "../compiler/FXCompilerError";
import { FXCompilerErrorException } from "../compiler/FXCompilerError";
import type { FXGraph, FXGraphDiff } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import type { FXNodeRegistry } from "./FXNodeRegistry";
import type { FXGraphSnapshotData } from "./FXSnapshotData";
import { FX_SNAPSHOT_VERSION } from "./FXSnapshotData";

/** Result of {@link FXGraphReconciler.reconcile}. */
export interface FXReconcileResult<N extends FXGraphNode = FXGraphNode> {
  readonly diff: FXGraphDiff<N>;
  /**
   * Instances that left the live set this reconcile (removed, replaced by a same-id
   * type change, or minted but never ingested). The caller defers `destroy()` until a
   * newer artifact is installed, since an already-installed artifact may still reference them.
   */
  readonly discarded: readonly N[];
  /**
   * Ids whose instance is new this reconcile (added, or a same-id type replacement).
   * Never built, so it holds no live handles - the orchestrator uses this to force a
   * recompile even when the structural hash is unchanged (an id-swap).
   */
  readonly freshIds: readonly string[];
  /** Problems this reconcile hit; non-empty means the graph must be treated as invalid. */
  readonly errors: readonly FXCompilerError[];
}

/**
 * Turns an editor {@link FXGraphSnapshotData} into a reconciled {@link FXGraph}, reusing
 * existing node instances by id so their compile-time handles survive across edits.
 * Lifecycle is by id-set membership, not reachability: a node newly in the set is
 * `prepare()`-ed here, one that left is returned in {@link FXReconcileResult.discarded}
 * for deferred destroy, one that only lost its connections stays resident. Never throws -
 * every failure folds into {@link FXReconcileResult.errors}.
 */
export class FXGraphReconciler<N extends FXGraphNode = FXGraphNode> {
  /**
   * Instances whose `prepare()` already ran successfully. One whose prepare threw stays
   * resident but out of this set, so the next reconcile retries it. A WeakSet so a
   * discarded instance drops out for GC.
   */
  private readonly prepared = new WeakSet<N>();

  constructor(private readonly registry: FXNodeRegistry<N>) {}

  /** Reconciles `graph` to `data`; prepares new nodes, returns the diff + discarded set. */
  public reconcile(graph: FXGraph<N>, data: FXGraphSnapshotData): FXReconcileResult<N> {
    const emptyDiff: FXGraphDiff<N> = { addedNodeIds: [], removedNodes: [] };

    // Version-locked to this build: no back-compat migration (the editor is unreleased, so no
    // snapshot predates the current wire format). A snapshot of any other version is rejected as
    // an error result - nothing mutated or minted - and the host resets (drop-and-restart) rather
    // than migrating. `version` arrives from JSON at runtime, so it may not match the literal type.
    const version = (data as { readonly version?: unknown }).version;
    if (version !== FX_SNAPSHOT_VERSION) {
      return {
        diff: emptyDiff,
        discarded: [],
        freshIds: [],
        errors: [
          {
            code: "unsupported-snapshot-version",
            message: `reconcile: snapshot version ${String(version)} does not match this build (${String(FX_SNAPSHOT_VERSION)}); a reset is required`,
          },
        ],
      };
    }
    const migrated: FXGraphSnapshotData = data;

    const nodes = new Map<string, N>();
    const replacedOld: N[] = [];
    const replacedIds: string[] = [];
    /** Instances created by this run - orphaned (thus discarded) if the run fails. */
    const minted: N[] = [];
    const errors: FXCompilerError[] = [];

    for (const [id, nodeData] of Object.entries(migrated.nodes)) {
      const existing = graph.getNode(id);

      // Every per-node throw site is caught and folded into a typed error carrying this node's id.
      try {
        if (existing?.type === nodeData.type) {
          existing.applyParams?.(nodeData.params ?? {});
          nodes.set(id, existing);
        } else {
          if (!this.registry.has(nodeData.type)) {
            throw new FXCompilerErrorException({
              code: "unknown-node-type",
              message: `FXGraphReconciler: no factory registered for node type "${nodeData.type}"`,
              nodeId: id,
            });
          }
          const fresh = this.registry.create(nodeData.type, nodeData.params);
          minted.push(fresh);
          nodes.set(id, fresh);
          if (existing !== undefined) {
            replacedOld.push(existing);
            replacedIds.push(id);
          }
        }
      } catch (error) {
        errors.push(reconcileError(error, id).error);
      }
    }

    if (errors.length > 0) {
      // Not ingested on a failed run: existing instances stay resident (an installed
      // artifact may reference them); only instances minted this run are orphaned.
      return { diff: emptyDiff, discarded: minted, freshIds: [], errors };
    }

    const diff = graph.ingest({
      nodes,
      connections: migrated.connections,
      outputBindings: migrated.outputBindings,
    });

    // Prepare every not-yet-prepared instance, including any whose earlier prepare()
    // threw (retried here instead of building forever over an unprepared node). A
    // throwing prepare() only marks the run invalid - the discarded set is unaffected.
    for (const [id, node] of nodes) {
      if (this.prepared.has(node)) {
        continue;
      }
      try {
        node.prepare?.();
        this.prepared.add(node);
      } catch (error) {
        errors.push(foldError(error, "reconcile-failed", id));
      }
    }

    return {
      diff,
      discarded: [...diff.removedNodes, ...replacedOld],
      freshIds: [...diff.addedNodeIds, ...replacedIds],
      errors,
    };
  }
}

/**
 * Normalizes a per-node reconcile failure into an {@link FXCompilerErrorException} tagged
 * with `nodeId`. A typed throw keeps its code; anything else becomes `bad-param`.
 */
function reconcileError(error: unknown, nodeId: string): FXCompilerErrorException {
  if (error instanceof FXCompilerErrorException) {
    return error.error.nodeId === undefined
      ? new FXCompilerErrorException({ ...error.error, nodeId })
      : error;
  }
  return new FXCompilerErrorException({
    code: "bad-param",
    message: error instanceof Error ? error.message : String(error),
    nodeId,
  });
}

/** Unpacks a typed throw, or folds any other into `code` (tagged when it applies). */
function foldError(
  error: unknown,
  code: FXCompilerError["code"],
  nodeId?: string,
): FXCompilerError {
  if (error instanceof FXCompilerErrorException) {
    return error.error.nodeId === undefined && nodeId !== undefined
      ? { ...error.error, nodeId }
      : error.error;
  }
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(nodeId !== undefined ? { nodeId } : {}),
  };
}
