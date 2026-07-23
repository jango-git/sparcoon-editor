/**
 * Fake nodes: authored like any node (reconcile/move/undo by id) but dropped at the compile
 * boundary (`serialize.ts`). The one type today is the route - a reroute knot spliced out at serialize.
 */

import type { FXNodeMeta } from "./nodePalette";

/** The one fake node type today. */
export const ROUTE_TYPE = "$route";

const FAKE_NODE_TYPES: ReadonlySet<string> = new Set([ROUTE_TYPE]);

export function isFakeNodeType(type: string): boolean {
  return FAKE_NODE_TYPES.has(type);
}

/** The route's single pass-through input and output. */
export const ROUTE_INPUT_KEY = "in";
export const ROUTE_OUTPUT_KEY = "out";

/** Not in the palette (a route is inserted onto a wire, never from the menu) but resolved
 *  by {@link metaForNode} so socket lookups treat a route like any pass-through node. */
export function routeMeta(): FXNodeMeta {
  return {
    type: ROUTE_TYPE,
    category: "math",
    domain: "shared",
    inputs: [{ key: ROUTE_INPUT_KEY, type: "T" }],
    outputs: [{ key: ROUTE_OUTPUT_KEY, type: "T" }],
    params: {},
    reads: [],
  };
}
