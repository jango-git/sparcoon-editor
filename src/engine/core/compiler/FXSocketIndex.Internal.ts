import type { FXGraphNode } from "../FXGraphNode";
import type { FXSocketDescriptor } from "../socket/FXSocket";

/** Key-indexed views of one node's input/output socket lists. */
interface FXSocketMaps {
  readonly in: ReadonlyMap<string, FXSocketDescriptor>;
  readonly out: ReadonlyMap<string, FXSocketDescriptor>;
}

/**
 * Per-instance socket-lookup cache, memoized since a node's sockets are fixed for its lifetime.
 * Keyed weakly so a discarded node is collectible without bookkeeping.
 */
const SOCKET_CACHE = new WeakMap<FXGraphNode, FXSocketMaps>();

/** Builds the key->descriptor maps, keeping the first descriptor per key (as a linear scan did). */
function buildMaps(node: FXGraphNode): FXSocketMaps {
  const inMap = new Map<string, FXSocketDescriptor>();
  for (const socket of node.inputs) {
    if (!inMap.has(socket.key)) {
      inMap.set(socket.key, socket);
    }
  }
  const outMap = new Map<string, FXSocketDescriptor>();
  for (const socket of node.outputs) {
    if (!outMap.has(socket.key)) {
      outMap.set(socket.key, socket);
    }
  }
  return { in: inMap, out: outMap };
}

/** Returns the cached socket maps for `node`, building them on first access. */
function mapsFor(node: FXGraphNode): FXSocketMaps {
  let maps = SOCKET_CACHE.get(node);
  if (maps === undefined) {
    maps = buildMaps(node);
    SOCKET_CACHE.set(node, maps);
  }
  return maps;
}

/** The input socket of `node` with the given key, or `undefined`. O(1) after first call. */
export function inputSocket(node: FXGraphNode, key: string): FXSocketDescriptor | undefined {
  return mapsFor(node).in.get(key);
}

/** The output socket of `node` with the given key, or `undefined`. O(1) after first call. */
export function outputSocket(node: FXGraphNode, key: string): FXSocketDescriptor | undefined {
  return mapsFor(node).out.get(key);
}
