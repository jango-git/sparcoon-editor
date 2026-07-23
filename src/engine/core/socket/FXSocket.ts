import type { FXSocketType } from "./FXValueType";

/** Static declaration of a single port on a node, exposed via {@link FXGraphNode.inputs}/`outputs`. */
export interface FXSocketDescriptor {
  readonly key: string;
  /** Concrete GLSL type, or the node's generic `T` (resolved per instance by {@link resolveGenerics}). */
  readonly type: FXSocketType;
  readonly label?: string;
  /** Inputs only: fails validation when unconnected with no {@link defaultValue}. */
  readonly required?: boolean;
  /** Inputs only: kept `unknown` to stay three-independent - the material adapter interprets it. */
  readonly defaultValue?: unknown;
}

/** Identifies one specific socket on one specific node instance in a graph. */
export interface FXSocketRef {
  readonly nodeId: string;
  readonly socketKey: string;
}

/**
 * Joins a socket reference into a stable string key (`"<nodeId> <socketKey>"`). Space-separated:
 * socket keys are identifiers with no whitespace, so the pairing stays injective regardless
 * of what the editor-supplied node id contains.
 */
export function socketRefKey(reference: FXSocketRef): string {
  return `${reference.nodeId} ${reference.socketKey}`;
}
