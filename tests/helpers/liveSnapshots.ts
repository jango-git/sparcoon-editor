import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";

/**
 * Builds a snapshot over nodes with one `in` input and one `out` output (the `chain` shape the
 * live-graph tests register). Each wire runs `[from, to]` as `from.out -> to.in`; `albedo` is
 * bound to `sink.out`.
 */
export function chainSnapshot(
  nodes: Readonly<Record<string, string>>,
  wires: readonly (readonly [from: string, to: string])[],
  sink: string,
): FXGraphSnapshotData {
  return {
    version: 2,
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, type]) => [id, { type }])),
    connections: wires.map(([from, to]) => ({
      from: { nodeId: from, socketKey: "out" },
      to: { nodeId: to, socketKey: "in" },
    })),
    outputBindings: [{ slot: "albedo", from: { nodeId: sink, socketKey: "out" } }],
  };
}

/** `b.out -> a.in`, `albedo <- a.out`: two reachable `chain` nodes. */
export const CHAIN_PAIR = chainSnapshot({ a: "chain", b: "chain" }, [["b", "a"]], "a");

/** {@link CHAIN_PAIR} with `b` (and its wire) removed: one reachable `chain` node `a`. */
export const CHAIN_SINGLE = chainSnapshot({ a: "chain" }, [], "a");
