import type { FXConnection, FXOutputBinding } from "../FXGraph";

/** Snapshot wire-format version. {@link FXGraphReconciler} rejects any other version. */
export const FX_SNAPSHOT_VERSION = 2;

/**
 * Serialized description of one node as pushed by the editor: a registered `type` plus a
 * plain-data `params` bag applied via {@link FXGraphNode.applyParams}. Carries no instance -
 * the library rebuilds or reuses instances by id (see {@link FXGraphReconciler}).
 */
export interface FXNodeData {
  readonly type: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** The wire form of a whole graph: the editor's serialized snapshot. */
export interface FXGraphSnapshotData {
  readonly version: 2;
  readonly nodes: Readonly<Record<string, FXNodeData>>;
  readonly connections: readonly FXConnection[];
  readonly outputBindings: readonly FXOutputBinding[];
}
