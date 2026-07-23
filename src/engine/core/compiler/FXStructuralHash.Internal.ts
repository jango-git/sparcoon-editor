import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";

/** FNV-1a prime, shared by both lanes. */
const FNV_PRIME = 0x01000193;
/**
 * Salt mixed into the second lane so both seed and input diverge from the first lane; a
 * collision must survive two independent 32-bit hashes. Value is free to change (never persisted).
 */
const FNV_SALT = "sparcoon-hash-lane2";

/** One 32-bit FNV-1a lane over `text`, rendered as 8 hex chars. */
function fnv1a32(text: string, offset: number): string {
  let hash = offset;
  // Code *units*, not code points: a surrogate pair must feed both halves or astral
  // characters sharing a high surrogate (most emoji) collide in both lanes.
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 64-bit structural hash as two concatenated 32-bit FNV-1a lanes (16 hex), kept as string
 * arithmetic (no BigInt) to stay cheap on the live-edit hot path. Exported for unit-testing only.
 */
export function fnv1a64(text: string): string {
  return fnv1a32(text, 0x811c9dc5) + fnv1a32(FNV_SALT + text, 0xcbf29ce4);
}

/**
 * Deterministic, id-independent, content-addressed hash: same hash => rebind, different =>
 * recompile. `order` must be topological; `nodeKey` folds in extra per-node state (phase, `T`).
 */
export function structuralHash<N extends FXGraphNode = FXGraphNode>(
  graph: FXGraph<N>,
  targetSignature: string,
  order: readonly string[],
  nodeKey?: (id: string, node: N) => string,
): string {
  // Content hash per node; children are hashed before parents thanks to `order`.
  const merkle = new Map<string, string>();
  for (const id of order) {
    const node = graph.getNode(id);
    if (node === undefined) {
      continue;
    }
    const variant = node.cacheKey?.() ?? "";
    const extra = nodeKey !== undefined ? nodeKey(id, node) : "";
    // Components are JSON-encoded so a third-party `type`/`cacheKey`/socket key
    // containing a bare delimiter cannot alias a differently-split neighbor
    // (e.g. type "a" + variant "b:" vs. type "a:b" + variant "").
    const parts: unknown[] = [[node.type, variant, extra]];
    for (const input of node.inputs) {
      const connection = graph.sourceOf({ nodeId: id, socketKey: input.key });
      if (connection === undefined) {
        parts.push([input.key]);
      } else {
        const sourceHash = merkle.get(connection.from.nodeId) ?? "?";
        parts.push([input.key, sourceHash, connection.from.socketKey]);
      }
    }
    merkle.set(id, fnv1a64(JSON.stringify(parts)));
  }

  // Sorted (slot, source hash, socket) entries so the hash is independent of
  // `outputBindings` array order; source hash disambiguates same-slot bindings across phases.
  const bindingEntries = graph.outputBindings.map((binding): string => {
    const sourceHash = merkle.get(binding.from.nodeId) ?? "?";
    // Phase folds in only when present, so a legacy (untagged) binding hashes unchanged.
    return JSON.stringify(
      binding.phase === undefined
        ? ["out", binding.slot, sourceHash, binding.from.socketKey]
        : ["out", binding.slot, sourceHash, binding.from.socketKey, binding.phase],
    );
  });
  bindingEntries.sort((a, b): number => a.localeCompare(b));

  return fnv1a64(JSON.stringify([targetSignature, ...bindingEntries]));
}

/**
 * Id-sensitive fingerprint of the reachable wiring - the companion {@link structuralHash}
 * deliberately is not, since content-addressing lets a role-swap between nodes hash unchanged.
 */
export function wiringFingerprint<N extends FXGraphNode = FXGraphNode>(
  graph: FXGraph<N>,
  reachable: ReadonlySet<string>,
): string {
  const entries: string[] = [];
  for (const connection of graph.connections) {
    // A connection shapes the artifact only when it feeds a reachable consumer.
    if (reachable.has(connection.to.nodeId) && reachable.has(connection.from.nodeId)) {
      entries.push(
        JSON.stringify([
          "c",
          connection.to.nodeId,
          connection.to.socketKey,
          connection.from.nodeId,
          connection.from.socketKey,
        ]),
      );
    }
  }
  for (const binding of graph.outputBindings) {
    if (reachable.has(binding.from.nodeId)) {
      entries.push(
        JSON.stringify(
          binding.phase === undefined
            ? ["b", binding.slot, binding.from.nodeId, binding.from.socketKey]
            : ["b", binding.slot, binding.from.nodeId, binding.from.socketKey, binding.phase],
        ),
      );
    }
  }
  entries.sort((a, b): number => a.localeCompare(b));
  return fnv1a64(JSON.stringify(entries));
}
