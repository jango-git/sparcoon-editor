import { commonSubexpressionElimination } from "./cse.Internal";
import { foldScalarLocals } from "./foldScalars.Internal";
import type { FXScalarLocal } from "./cse.Internal";
import { printJSLocals } from "./printJS.Internal";
import type { FXRate, FXRatedLocal } from "./rates.Internal";
import { freeEverywhere, operationCount } from "./rates.Internal";
import { scalarComponentIndex, scalarComponentName, scalarize } from "./scalarize.Internal";
import type { FXExpr, FXRefKind } from "../ir/FXExpr";
import { ref } from "../ir/FXExprBuilder";
import { FX_FUNCTIONS } from "../ir/FXFunctions.Internal";
import { childrenOf, refNames, replaceRefs } from "../ir/visit.Internal";
import type { FXValueType } from "../socket/FXValueType";
import { isIntType } from "../socket/FXValueType";

/**
 * The draw stage of a compiled graph: what is one for the whole draw (or simulation pass) and
 * known before it - the clock, the sampled pose, the object's motion, a parameter - computed once
 * on the CPU by the artifact's `compute(inputs, uniforms)` and read by the shader as uniforms,
 * instead of per vertex, fragment or particle on the GPU. Shading-language and domain neutral: the
 * render tiers and the GPU behavior kernel lift through it, each with its own inputs (its policy).
 */

/** A local as a compiler holds it: its IR and its type. */
export interface FXTypedLocal extends FXRatedLocal {
  readonly type: FXValueType;
}

/** The body of an artifact's `compute(inputs, uniforms)`, and the JS helpers it calls. */
export interface FXCompiledDrawStage {
  readonly statements: readonly string[];
  /** Helper sources, each once, dependencies first. */
  readonly helpers: readonly string[];
}

/** What lifting needs of the compiler: its per-pass inputs, its uniforms, its budget. */
export interface FXDrawStagePolicy {
  /** The highest rate a value lifted to the CPU may have (what reads nothing faster than the pass). */
  readonly rate: FXRate;
  /**
   * The fewest operations, per stage (in the order of the stages lifted), a value read in that
   * stage must cost the CPU to be worth a uniform: a uniform costs each draw a little on the CPU, an
   * operation costs the GPU each invocation of the stage - next to nothing at a time, so a cheap
   * value pays off only where the stage runs very often (per fragment), not per vertex or particle.
   */
  readonly minimumCost: readonly number[];
  /** Whether the CPU has `ref` (not a local): a per-pass input or a parameter it reads. */
  readsOnCPU(ref: Extract<FXExpr, { kind: "ref" }>): boolean;
  /**
   * The JS reading, inside `compute(inputs, uniforms)`, of `base` - a non-local ref of `kind` the
   * lifted values read - or of its component `index` (a vector or matrix one, scalarized).
   */
  printInput(kind: FXRefKind, base: string, index: number | undefined): string;
  /** Whether draw uniforms of `types`, beside the graph's own uniforms, fit what the tier allows. */
  fits(types: readonly FXValueType[]): boolean;
  /** Declares one draw uniform of `type` (seeded to zero) and returns its name. */
  declareUniform(type: FXValueType): string;
}

/** A graph's locals by stage, after lifting: what the GPU still computes. */
export interface FXDrawStageLift<L extends FXTypedLocal> {
  /** In the order of the stages given. */
  readonly stages: readonly (readonly L[])[];
  /** The draw uniform an output slot now reads, by the lifted local it read. */
  readonly renamed: ReadonlyMap<string, string>;
  /** Absent when nothing was worth lifting or nothing fits. */
  readonly stage: FXCompiledDrawStage | undefined;
}

/** The value types the CPU computes as JS numbers exactly as the GPU does (an integer divides apart). */
export const CPU_TYPES: ReadonlySet<string> = new Set([
  "float",
  "vec2",
  "vec3",
  "vec4",
  "mat2",
  "mat3",
  "mat4",
]);

/**
 * Lifts the CPU-computable values of at most `policy.rate` of a graph's `stages` (its locals by
 * the stage they run in, in definition order across them) into a draw stage. Only the roots - the
 * lifted values a live GPU local or an output slot (`stageSlotReads`, by stage) reads - become
 * uniforms; what they read stays on the CPU alone. A constant or a free alias of what both sides
 * read is computed on both, never a uniform. A root costing less than the stages reading it ask
 * (`policy.minimumCost`) goes back to the GPU, and while the roots do not fit, the cheapest does,
 * with what reads it.
 */
export function liftDrawStage<L extends FXTypedLocal>(
  stages: readonly (readonly L[])[],
  stageSlotReads: readonly ReadonlySet<string>[],
  rates: ReadonlyMap<string, FXRate>,
  policy: FXDrawStagePolicy,
): FXDrawStageLift<L> {
  const all = stages.flat();
  const slotReads = new Set(stageSlotReads.flatMap((names) => [...names]));
  const stageOf = new Map(
    stages.flatMap((locals, stage) => locals.map((local) => [local.name, stage] as const)),
  );
  const reads = new Map(all.map((local) => [local.name, refNames(local.expr, "local", new Set())]));
  const live = liveLocals(all, reads, slotReads);

  // A constant, or a free alias of what both sides read, is computed on both sides - the CPU
  // needs it for what it lifts, the shader reads or folds it for free - and never becomes a
  // uniform itself.
  const shared = freeEverywhere(all, reads, rates, policy.rate);
  // What goes back to the GPU only grows, so the loop below ends.
  const returned = new Set<string>();
  // Definition order: a local's reads are decided before it, and a local reading one gone back
  // goes back with it.
  const select = (): Set<string> => {
    const chosen = new Set<string>();
    for (const local of all) {
      if (
        !returned.has(local.name) &&
        live.has(local.name) &&
        (rates.get(local.name) ?? Infinity) <= policy.rate &&
        CPU_TYPES.has(local.type.glslTypeName) &&
        computesOnCPU(local.expr, chosen, policy)
      ) {
        chosen.add(local.name);
      }
    }
    return chosen;
  };

  const byName = new Map(all.map((local) => [local.name, local]));
  const localOf = (name: string): L => {
    const local = byName.get(name);
    if (local === undefined) {
      throw new Error(`liftDrawStage: no local "${name}"`);
    }
    return local;
  };
  /** What `root` needs computed on the CPU, itself included: its cost in operations. */
  const cost = (root: string, among: ReadonlySet<string>): number => {
    const reached = new Set<string>();
    const pending = [root];
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      if (among.has(name) && !reached.has(name)) {
        reached.add(name);
        pending.push(...(reads.get(name) ?? []));
      }
    }
    return [...reached].reduce((sum, name) => sum + operationCount(localOf(name).expr), 0);
  };

  /** The least `policy.minimumCost` of the stages the GPU reads `root` in. */
  const minimumCostOf = (root: string, chosen: ReadonlySet<string>): number => {
    const costs: number[] = [];
    stageSlotReads.forEach((names, stage) => {
      if (names.has(root)) {
        costs.push(policy.minimumCost[stage] ?? 0);
      }
    });
    for (const local of all) {
      const onGPU = !chosen.has(local.name) || shared.has(local.name);
      if (onGPU && live.has(local.name) && reads.get(local.name)?.has(root) === true) {
        costs.push(policy.minimumCost[stageOf.get(local.name) ?? 0] ?? 0);
      }
    }
    return Math.min(...costs);
  };
  /** Whether a lifted local reads `root`: the CPU needs it then, whatever it costs the GPU. */
  const readOnCPU = (root: string, chosen: ReadonlySet<string>): boolean =>
    [...chosen].some((name) => !shared.has(name) && reads.get(name)?.has(root) === true);

  let selected = select();
  let roots = frontier(all, selected, shared, reads, live, slotReads);
  for (;;) {
    const current = selected;
    // A root too cheap for the stages reading it goes back to the GPU, with what only it reads.
    const cheap = roots.filter(
      (name) => !readOnCPU(name, current) && cost(name, current) < minimumCostOf(name, current),
    );
    if (cheap.length > 0) {
      for (const name of cheap) {
        returned.add(name);
      }
      selected = select();
      roots = frontier(all, selected, shared, reads, live, slotReads);
      continue;
    }
    if (roots.length === 0 || policy.fits(roots.map((name) => localOf(name).type))) {
      break;
    }
    returned.add(
      roots.reduce((best, name) => (cost(name, current) < cost(best, current) ? name : best)),
    );
    selected = select();
    roots = frontier(all, selected, shared, reads, live, slotReads);
  }
  if (roots.length === 0) {
    return { stages, renamed: new Map(), stage: undefined };
  }

  // What the CPU computes: the roots and what they read (shared locals among it).
  const needed = new Set<string>();
  const pending = [...roots];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (selected.has(name) && !needed.has(name)) {
      needed.add(name);
      pending.push(...(reads.get(name) ?? []));
    }
  }
  // The draw uniform standing for each root, by the root's name.
  const uniformOf = new Map(
    roots.map((name) => [name, policy.declareUniform(localOf(name).type)] as const),
  );
  // A shared local stays on the GPU only while something left there reads it; a dead one stays
  // nowhere - it may read a value lifted away from the GPU.
  const keptOnGPU = new Set(
    all
      .filter(
        (local) =>
          live.has(local.name) &&
          (!selected.has(local.name) || (shared.has(local.name) && slotReads.has(local.name))),
      )
      .map((local) => local.name),
  );
  for (const local of [...all].reverse()) {
    if (keptOnGPU.has(local.name)) {
      for (const name of reads.get(local.name) ?? []) {
        if (shared.has(name) && !uniformOf.has(name)) {
          keptOnGPU.add(name);
        }
      }
    }
  }
  const onGPU = (locals: readonly L[]): L[] =>
    locals
      .filter((local) => keptOnGPU.has(local.name))
      .map((local) => ({
        ...local,
        expr: replaceRefs(local.expr, (candidate) => {
          const uniform = candidate.ref === "local" ? uniformOf.get(candidate.name) : undefined;
          return uniform === undefined ? undefined : ref("uniform", uniform, candidate.type);
        }),
      }));
  return {
    stages: stages.map(onGPU),
    renamed: new Map([...uniformOf].filter(([name]) => slotReads.has(name))),
    stage: printDrawStage(
      all.filter((local) => needed.has(local.name)),
      uniformOf,
      policy,
    ),
  };
}

/** Whether the CPU can compute `expr`: every call has a JS form, every read is a local already
 *  lifted or one `policy` gives the CPU - no GLSL `raw`, no impure call, no integer value. */
function computesOnCPU(
  expr: FXExpr,
  lifted: ReadonlySet<string>,
  policy: FXDrawStagePolicy,
): boolean {
  // JS numbers divide and wrap as floats: an integer value anywhere inside stays on the GPU.
  if (isIntType(expr.type)) {
    return false;
  }
  switch (expr.kind) {
    case "lit":
      return true;
    case "ref":
      return expr.ref === "local" ? lifted.has(expr.name) : policy.readsOnCPU(expr);
    case "raw":
      return false;
    case "call": {
      const definition = FX_FUNCTIONS.get(expr.fn);
      if (
        definition === undefined ||
        definition.standardOnly === true ||
        definition.impure === true
      ) {
        return false;
      }
      break;
    }
    case "bin":
    case "un":
    case "swizzle":
    case "column":
    case "construct":
    case "select":
      break;
  }
  return childrenOf(expr).every((child) => computesOnCPU(child, lifted, policy));
}

/** The locals an output slot reads, transitively: only these are worth computing at all. */
function liveLocals(
  all: readonly FXTypedLocal[],
  reads: ReadonlyMap<string, ReadonlySet<string>>,
  slotReads: ReadonlySet<string>,
): Set<string> {
  const live = new Set(slotReads);
  for (const local of [...all].reverse()) {
    if (live.has(local.name)) {
      for (const name of reads.get(local.name) ?? []) {
        live.add(name);
      }
    }
  }
  return live;
}

/** The selected locals - shared ones aside - a live GPU local or an output slot reads, in
 *  definition order. A shared local stays on the GPU too, so what it reads is read there. */
function frontier(
  all: readonly FXTypedLocal[],
  selected: ReadonlySet<string>,
  shared: ReadonlySet<string>,
  reads: ReadonlyMap<string, ReadonlySet<string>>,
  live: ReadonlySet<string>,
  slotReads: ReadonlySet<string>,
): string[] {
  const readOnGPU = new Set<string>();
  for (const local of all) {
    if (live.has(local.name) && (!selected.has(local.name) || shared.has(local.name))) {
      for (const name of reads.get(local.name) ?? []) {
        readOnGPU.add(name);
      }
    }
  }
  return all
    .map((local) => local.name)
    .filter(
      (name) =>
        selected.has(name) && !shared.has(name) && (readOnGPU.has(name) || slotReads.has(name)),
    );
}

/** `compute`'s body: the lifted locals per component (common subexpressions shared), then each
 *  root written into its draw uniform. */
function printDrawStage(
  lifted: readonly FXTypedLocal[],
  uniformOf: ReadonlyMap<string, string>,
  policy: FXDrawStagePolicy,
): FXCompiledDrawStage {
  // Each non-local value the lifted locals read, renamed to a token of its own before scalarizing:
  // a component then names its value unambiguously (`tint`'s x apart from a value named `tint_x`).
  const inputs = new Map<string, { readonly kind: FXRefKind; readonly name: string }>();
  const tokens = new Map<string, string>();
  const tokenOf = (kind: FXRefKind, name: string): string => {
    const key = `${kind}:${name}`;
    let token = tokens.get(key);
    if (token === undefined) {
      token = `$${String(tokens.size)}`;
      tokens.set(key, token);
      inputs.set(token, { kind, name });
    }
    return token;
  };
  const scalars: FXScalarLocal[] = [];
  const components = new Map<string, readonly string[]>();
  for (const local of lifted) {
    const expr = replaceRefs(local.expr, (candidate) =>
      candidate.ref === "local"
        ? undefined
        : ref(candidate.ref, tokenOf(candidate.ref, candidate.name), candidate.type),
    );
    const parts = scalarize(expr);
    const names = parts.map((_, index) =>
      parts.length === 1 ? local.name : scalarComponentName(local.name, index),
    );
    parts.forEach((part, index) => scalars.push({ name: names[index] ?? local.name, expr: part }));
    components.set(local.name, names);
  }
  // What each root's uniform is written from: kept, every other folded constant substituted away.
  const written = new Set([...uniformOf.keys()].flatMap((name) => components.get(name) ?? []));
  let counter = 0;
  const optimized = commonSubexpressionElimination(
    foldScalarLocals(scalars, written),
    (hint) => `${hint}$${String(counter++)}`,
    (fn) => FX_FUNCTIONS.get(fn)?.impure === true,
  );
  const resolve = (candidate: Extract<FXExpr, { kind: "ref" }>): string => {
    if (candidate.ref === "local") {
      return candidate.name;
    }
    const whole = inputs.get(candidate.name);
    if (whole !== undefined) {
      return policy.printInput(whole.kind, whole.name, undefined);
    }
    // A token holds no `_`: a component's name is its token, `_` and the component.
    const base = candidate.name.slice(0, candidate.name.indexOf("_"));
    const input = inputs.get(base);
    const index = input === undefined ? undefined : scalarComponentIndex(candidate.name, base);
    if (input === undefined || index === undefined) {
      throw new Error(`liftDrawStage: "${candidate.name}" is no value the draw stage reads`);
    }
    return policy.printInput(input.kind, input.name, index);
  };
  const helpers = new Map<string, string>();
  const statements = printJSLocals(optimized, FX_FUNCTIONS, resolve, helpers);
  for (const [local, uniform] of uniformOf) {
    const names = components.get(local) ?? [];
    statements.push(
      ...(names.length === 1
        ? [`${uniformValueJS(uniform, undefined)} = ${names[0] ?? local};`]
        : names.map((name, index) => `${uniformValueJS(uniform, index)} = ${name};`)),
    );
  }
  return { statements, helpers: [...helpers.values()] };
}

/**
 * The JS reading, inside `compute(inputs, uniforms)`, of the value of uniform slot `name` - or of
 * its component `index` - in `uniforms`, the instance's own slots.
 */
export function uniformValueJS(name: string, index: number | undefined): string {
  return `uniforms[${JSON.stringify(name)}].value${componentJS(index)}`;
}

/** The JS index of component `index` of a value, or nothing for the value as a whole. */
export function componentJS(index: number | undefined): string {
  return index === undefined ? "" : `[${String(index)}]`;
}
