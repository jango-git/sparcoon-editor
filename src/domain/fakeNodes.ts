/**
 * Fake nodes are authored like any node but removed at serialize. The only type is the route, a
 * reroute knot spliced out at serialize.
 */

import type { FXNodeMeta } from "./nodePalette";

export const ROUTE_TYPE = "$route";

const FAKE_NODE_TYPES: ReadonlySet<string> = new Set([ROUTE_TYPE]);

export function isFakeNodeType(type: string): boolean {
  return FAKE_NODE_TYPES.has(type);
}

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
