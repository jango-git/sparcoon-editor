import type { FXGraphNode } from "./FXGraphNode";
import type { FXSocketRef } from "./socket/FXSocket";
import { socketRefKey } from "./socket/FXSocket";

/** A directed edge from an output socket to an input socket. */
export interface FXConnection {
  readonly from: FXSocketRef;
  readonly to: FXSocketRef;
}

/** Binds a node output socket to one of the target's output slots. */
export interface FXOutputBinding {
  /** Target output slot name (e.g. `"albedo"`). */
  readonly slot: string;
  readonly from: FXSocketRef;
  /**
   * Behavior only: authoritative placement signal pinning the producing node to this
   * phase's kernel. Absent on render/legacy graphs, where phase is inferred from the producer.
   */
  readonly phase?: "spawn" | "update";
}

/**
 * Editor is master: the library only ingests snapshots, never edits topology. Node ids
 * are the editor's stable ids, reconciled across snapshots to keep GPU/uniform handles alive.
 */
export interface FXGraphSnapshot<N extends FXGraphNode = FXGraphNode> {
  readonly nodes: ReadonlyMap<string, N>;
  readonly connections: readonly FXConnection[];
  readonly outputBindings: readonly FXOutputBinding[];
}

/**
 * Set-membership diff, not reachability - a node that merely lost its connections stays
 * resident (simply uncompiled). Host decides `destroy()` lifecycle for `removedNodes`.
 */
export interface FXGraphDiff<N extends FXGraphNode = FXGraphNode> {
  readonly addedNodeIds: readonly string[];
  readonly removedNodes: readonly N[];
}

/**
 * No `addNode`/`removeNode`: the editor is the source of truth and pushes whole
 * {@link FXGraphSnapshot}s via {@link ingest}; unreachable nodes simply don't compile.
 */
export class FXGraph<N extends FXGraphNode = FXGraphNode> {
  private nodesById: ReadonlyMap<string, N> = new Map();
  private connectionsList: readonly FXConnection[] = [];
  private bindings: readonly FXOutputBinding[] = [];

  /** Index: input-socket key -> the (first) connection feeding it. */
  private sourceByInput: Map<string, FXConnection> = new Map();

  public get nodes(): ReadonlyMap<string, N> {
    return this.nodesById;
  }

  public get connections(): readonly FXConnection[] {
    return this.connectionsList;
  }

  public get outputBindings(): readonly FXOutputBinding[] {
    return this.bindings;
  }

  /**
   * Replaces the graph and reports the set-membership diff. Does not call `destroy()` on
   * removed nodes - that lifecycle choice belongs to the host ({@link FXGraphDiff.removedNodes}).
   */
  public ingest(snapshot: FXGraphSnapshot<N>): FXGraphDiff<N> {
    const previous = this.nodesById;

    const addedNodeIds: string[] = [];
    for (const id of snapshot.nodes.keys()) {
      if (!previous.has(id)) {
        addedNodeIds.push(id);
      }
    }

    const removedNodes: N[] = [];
    for (const [id, node] of previous) {
      if (!snapshot.nodes.has(id)) {
        removedNodes.push(node);
      }
    }

    this.nodesById = snapshot.nodes;
    this.connectionsList = snapshot.connections;
    this.bindings = snapshot.outputBindings;
    this.reindex();

    return { addedNodeIds, removedNodes };
  }

  public getNode(id: string): N | undefined {
    return this.nodesById.get(id);
  }

  /**
   * Drops nodes/connections/bindings so a destroyed graph doesn't pin its (already
   * destroyed) nodes' LUTs/handles for the GC. Does not call `destroy()` - host's job.
   */
  public clear(): void {
    this.nodesById = new Map();
    this.connectionsList = [];
    this.bindings = [];
    this.reindex();
  }

  /**
   * Input carries at most one source; a duplicate is a validation error surfaced by
   * {@link FXCompilerBaseline.validate} - this index just keeps the first occurrence.
   */
  public sourceOf(input: FXSocketRef): FXConnection | undefined {
    return this.sourceByInput.get(socketRefKey(input));
  }

  /** Rebuilds derived lookup indices from the current topology. */
  private reindex(): void {
    this.sourceByInput = new Map();
    for (const connection of this.connectionsList) {
      const key = socketRefKey(connection.to);
      if (!this.sourceByInput.has(key)) {
        this.sourceByInput.set(key, connection);
      }
    }
  }
}
