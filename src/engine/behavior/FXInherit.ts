import { FX_ID, FX_LIFETIME } from "sparcoon";

import type { FXCompilerError } from "../core/compiler/FXCompilerError";
import { collectReachableNodeIds } from "../core/compiler/FXGraphTraversal.Internal";
import type { FXGraph } from "../core/FXGraph";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import type {
  FXInheritBuiltin,
  FXInheritEntry,
  FXInheritPlan,
  FXInheritRequest,
  FXInheritSource,
} from "./FXInheritPlan";

/**
 * Inheritance: what a newborn takes from the particle whose death spawned it. A spawn graph reads
 * an inherited value through an `inherited-attribute` node, which requests it here; the requests
 * of a graph lay out its emitter's inherit layout (the runtime's `FXInheritLayout`), a flat run of
 * floats every birth of one spawn call shares. Which of the dying particle's floats fill it is a
 * death reaction's own (see `domain/reactionLinking.ts`): this side knows only what it reads.
 */

/** Every inheritable core field, in the order a picker offers them. */
export const FX_INHERIT_BUILTINS: readonly FXInheritBuiltin[] = ["id", "lifetime"];

/** Where each inheritable core field lies in the `lifecycle` field of a slot. */
export const FX_INHERIT_BUILTIN_COMPONENT: Readonly<Record<FXInheritBuiltin, number>> = {
  id: FX_ID,
  lifetime: FX_LIFETIME,
};

/**
 * What a birth no death spawned reads for a core field: an id no particle has, so a graph can
 * tell such a birth apart, and no lifetime.
 */
export const FX_INHERIT_BUILTIN_DEFAULTS: Readonly<Record<FXInheritBuiltin, number>> = {
  id: -1,
  lifetime: 0,
};

/** The kernel input reading the inherited value `source` names - per source alone, so a graph
 *  requesting one source at two types is one conflict, not two values. */
function sourceKey(source: FXInheritSource): string {
  return source.kind === "attribute" ? `attribute_${source.name}` : `builtin_${source.field}`;
}

// A float as the hex of its float32 bits: what the runtime keeps of a default, exactly.
const FLOAT_BITS = new DataView(new ArrayBuffer(4));
function floatBits(value: number): string {
  FLOAT_BITS.setFloat32(0, value);
  return FLOAT_BITS.getUint32(0).toString(16).padStart(8, "0");
}

/**
 * The kernel input a request reads: an identifier naming its source, type and defaults, so two
 * requests read one input - one value of the layout - exactly when they would read the same floats.
 */
export function inheritInputName(request: FXInheritRequest): string {
  const defaults = request.defaults.map(floatBits).join("_");
  return `INHERITED_${sourceKey(request.source)}_${request.type.id}_${defaults}`;
}

/** The floats one vec4 of the GPU kernel's inherited uniform holds - no value crosses one. */
export const FX_INHERIT_VECTOR_COMPONENTS = 4;

/**
 * Lays `requests` out, one value per distinct input, ordered by input name (so the order requests
 * come in never moves a value). No value crosses a vec4: the GPU kernel reads each with one
 * swizzle of one element of its inherited uniform.
 */
export function planInherits(requests: readonly FXInheritRequest[]): FXInheritPlan {
  const byInput = new Map<string, FXInheritRequest>();
  for (const request of requests) {
    byInput.set(inheritInputName(request), request);
  }
  const names = [...byInput.keys()].sort();
  const entries: FXInheritEntry[] = [];
  let cursor = 0;
  for (const inputName of names) {
    const request = byInput.get(inputName);
    if (request === undefined) {
      continue;
    }
    const components = request.type.components;
    if ((cursor % FX_INHERIT_VECTOR_COMPONENTS) + components > FX_INHERIT_VECTOR_COMPONENTS) {
      cursor = Math.ceil(cursor / FX_INHERIT_VECTOR_COMPONENTS) * FX_INHERIT_VECTOR_COMPONENTS;
    }
    entries.push({ request, inputName, offset: cursor });
    cursor += components;
  }
  const defaults = new Array<number>(cursor).fill(0);
  for (const entry of entries) {
    entry.request.defaults.forEach((value, component) => {
      defaults[entry.offset + component] = value;
    });
  }
  return { entries, layout: { stride: cursor, defaults } };
}

/** The inheritance requests of a graph's reachable nodes, and the conflicts among them. */
export interface FXInheritCollection {
  readonly requests: readonly FXInheritRequest[];
  /** One per source requested at two types. */
  readonly errors: readonly FXCompilerError[];
}

/**
 * Gathers the {@link FXInheritRequest}s of the reachable nodes of `graph` - an unreachable
 * `inherited-attribute` must not widen the layout. Two requests of one source and type with other
 * defaults are two values; one source at two types is an error.
 */
export function collectInheritRequests(graph: FXGraph<FXBehaviorNode>): FXInheritCollection {
  const requests: FXInheritRequest[] = [];
  const errors: FXCompilerError[] = [];
  const typeBySource = new Map<string, string>();
  for (const id of collectReachableNodeIds(graph)) {
    const request = graph.getNode(id)?.inheritRequest;
    if (request === undefined) {
      continue;
    }
    const key = sourceKey(request.source);
    const known = typeBySource.get(key);
    if (known !== undefined && known !== request.type.id) {
      errors.push({
        code: "inherit-type-conflict",
        message: `inherited ${inheritSourceLabel(request.source)} is read as both ${known} and ${request.type.id}`,
        nodeId: id,
        params: {
          source: inheritSourceLabel(request.source),
          firstType: known,
          secondType: request.type.id,
        },
      });
      continue;
    }
    typeBySource.set(key, request.type.id);
    requests.push(request);
  }
  return { requests, errors };
}

/**
 * The source an `inherited-attribute` node's stored params name: `source` (`"builtin"` for a core
 * field, else an attribute) and `name`. The one reading of those params - the node, the editor's
 * picker and its warnings all go through it.
 */
export function inheritSourceOf(parameters: Readonly<Record<string, unknown>>): FXInheritSource {
  const name = String(parameters["name"] ?? "");
  return parameters["source"] === "builtin"
    ? { kind: "builtin", field: name as FXInheritBuiltin }
    : { kind: "attribute", name };
}

/** A source as a person reads it: an attribute's name, or a core field's. */
export function inheritSourceLabel(source: FXInheritSource): string {
  return source.kind === "attribute" ? source.name : source.field;
}
