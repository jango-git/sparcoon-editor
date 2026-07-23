/**
 * Socket connectability rules for wiring: whether a value of one socket type can flow into another.
 * Numeric widths are mutually connectable (the engine's `coerceNumeric` pads / truncates / splats),
 * a generic ("T") input accepts only the types its node's constraint allows, and a socket never
 * wires to itself or to another on the same side / node. Purely domain rules - no graph, no DOM.
 */

import { isNumericSocketType } from "../../domain/socketTypes";
import { nodeFamily } from "../../domain/nodeFamilies";
import type { FXNodeMeta } from "../../domain/nodePalette";
import type { SocketRef } from "./nodeView";

/**
 * The types a generic ("T") input accepts: a family facade's variant options, else the engine
 * constraint list. `"any"` for a pure pass-through (a route forwards whatever it is fed).
 */
export type AcceptedTypes = readonly string[] | "any";

/**
 * Whether a value of one concrete socket type can flow into another, by type alone (the caller
 * checks side/node). Identical types match, and any numeric width feeds any other - the compiler
 * pads / truncates / splats to the target socket (see the engine's `coerceNumeric`). Symmetric.
 * `"T"` is NOT handled here (it needs the node's constraint - see {@link inputAcceptsSource}).
 */
export function typesConnectable(a: string, b: string): boolean {
  if (a === b || a === "T" || b === "T") {
    return true;
  }
  return isNumericSocketType(a) && isNumericSocketType(b);
}

/**
 * Whether a source type may feed an INPUT socket. A concrete input coerces numerically (as
 * {@link typesConnectable}); a still-generic (`"T"`) input accepts only its constrained set -
 * so a `float` cannot feed a vector-only `split`, nor a `vec3` a matrix-only `transpose`, matching
 * the engine's `resolveGenerics`. `"any"`/`undefined` stays permissive (a route, or an unresolvable
 * node) rather than wrongly blocking a wire.
 */
export function inputAcceptsSource(
  sourceType: string,
  inputType: string,
  accepted: AcceptedTypes | undefined,
): boolean {
  if (inputType !== "T") {
    return typesConnectable(sourceType, inputType);
  }
  if (accepted === undefined || accepted === "any") {
    return true;
  }
  return accepted.includes(sourceType);
}

/**
 * The accepted set for a node's generic (`"T"`) input, from its metadata: a family facade's
 * options (the superset incl. matrices - the engine `split`/`combine` constraint is too narrow for
 * the facade), else the engine `generic.constraint`. `undefined` for a non-generic node.
 */
export function acceptedGenericTypesForMeta(metadata: FXNodeMeta): AcceptedTypes | undefined {
  const family = nodeFamily(metadata.type);
  if (family !== undefined) {
    return family.options;
  }
  return metadata.generic?.constraint;
}

/**
 * Whether two sockets may be wired: opposite sides, different nodes, connectable types. Pass the
 * accepted set for whichever socket is the INPUT (resolved by the caller, which has the graph);
 * it only matters when that input is still generic `"T"`.
 */
export function socketsCompatible(
  a: SocketRef,
  b: SocketRef,
  acceptedForInput?: AcceptedTypes,
): boolean {
  if (a.side === b.side || a.nodeId === b.nodeId) {
    return false;
  }
  const input = a.side === "input" ? a : b;
  const output = a.side === "input" ? b : a;
  return inputAcceptsSource(output.type, input.type, acceptedForInput);
}
