import type { FXGraphNode } from "../FXGraphNode";
import type { FXExpr } from "../ir/FXExpr";
import type { FXGLSLTypeName, FXValueType } from "../socket/FXValueType";
import type { FXCurveData, FXGradientData, FXParamSpec } from "./FXParamSpec";
import type {
  FXNodeCategory,
  FXNodeMeta,
  FXParamMeta,
  FXSocketMeta,
  FXSocketSpec,
  FXTargetInputDefault,
} from "./FXSocketSpec";
import type { FXDescriptorBuild } from "./defineNode.Internal";
import { FXDescriptorNode, narrowestGenericType } from "./defineNode.Internal";
import { deepFreeze } from "./deepFreeze.Internal";
import type { FXExprBuilderApi } from "../ir/FXExprBuilder";

/** Backend a descriptor instance is compiled against. */
export type FXNodeBackend = "render" | "behavior";
/** GLSL stage name (mirrors `FXShaderStage`; kept as a literal to keep core three-/backend-free). */
export type FXRenderStageName = "vertex" | "fragment";
/** Behavior phase name (mirrors `FXBehaviorPhase`). */
export type FXBehaviorPhaseName = "spawn" | "update";

/** The IR-builder facade handed to a descriptor's `build` (pure builders + a bound `call`). */
export type { FXExprBuilderApi };

/** Resolves a parameter specification to the value `build` receives: an IR expr, or a structural literal. */
type FXResolvedParam<S extends FXParamSpec> = S extends { kind: "value" }
  ? FXExpr
  : S extends { type: "enum" }
    ? string
    : S extends { type: "flag" }
      ? boolean
      : S extends { type: "valueType" }
        ? FXGLSLTypeName
        : S extends { type: "gradient" }
          ? FXGradientData
          : S extends { type: "curve" }
            ? FXCurveData
            : never;

/** Parameter bag as seen inside a descriptor's `build`. */
export type FXResolvedParams<P extends Record<string, FXParamSpec>> = {
  readonly [K in keyof P]: FXResolvedParam<P[K]>;
};

/**
 * Whether a socket's `build`-time value is guaranteed present: a required input, or one with
 * a static fallback ({@link FXSocketSpec.default}) or editable inline default
 * ({@link FXSocketSpec.value}) - the population rules `FXDescriptorNode.runBuild` follows.
 */
type FXInputGuaranteed<S extends FXSocketSpec> = S extends
  | { readonly required: true }
  | { readonly default: FXExpr | FXTargetInputDefault }
  | { readonly value: number | readonly number[] }
  ? true
  : false;

/** Resolves a socket specification to the value `build` receives for that key. */
type FXResolvedInput<S extends FXSocketSpec> =
  FXInputGuaranteed<S> extends true ? FXExpr : FXExpr | undefined;

/** Input bag as seen inside a descriptor's `build`, one entry per declared input socket. */
export type FXResolvedInputs<I extends Record<string, FXSocketSpec>> = {
  readonly [K in keyof I]: FXResolvedInput<I[K]>;
};

/** Resolves a parameter specification to the input type its factory / snapshot accepts. */
type FXParamInput<S extends FXParamSpec> = S extends { type: "float" }
  ? number
  : S extends { type: "vec2" | "vec3" | "vec4" }
    ? readonly number[]
    : S extends { type: "generic" }
      ? number | readonly number[]
      : S extends { type: "curve" }
        ? FXCurveData
        : S extends { type: "gradient" }
          ? FXGradientData
          : S extends { type: "enum" }
            ? string
            : S extends { type: "flag" }
              ? boolean
              : S extends { type: "valueType" }
                ? FXGLSLTypeName
                : never;

/** Typed, all-optional parameter bag accepted when creating a descriptor instance. */
export type FXNodeParams<P extends Record<string, FXParamSpec>> = {
  readonly [K in keyof P]?: FXParamInput<P[K]>;
};

/** Arguments a node's {@link FXNodeCost} function receives. */
export interface FXNodeCostArgs {
  /** The node's current structural/value param values, keyed by name (not input-socket pins). */
  readonly params: Readonly<Record<string, unknown>>;
  /** The node's resolved generic type; `float` for a non-generic node. */
  readonly resolvedT: FXValueType;
}

/**
 * A node's static complexity estimate (see {@link FXGraphNode.estimateCost}): a flat number, or
 * a function of its current params/resolved type for a cost that varies with a choice.
 */
export type FXNodeCost = number | ((args: FXNodeCostArgs) => number);

/**
 * Declarative description of a standard node: sockets, params, and a pure {@link build}
 * over the IR. {@link defineNode} derives `applyParams`/`syncLiveValues`/`cacheKey` and
 * the uniform/binding allocation.
 */
export interface FXNodeDescriptor<
  P extends Record<string, FXParamSpec>,
  I extends Record<string, FXSocketSpec> = Record<string, FXSocketSpec>,
> {
  /** Stable node-type identifier (kebab-case, e.g. `"gravity"`). */
  readonly type: string;
  /** Backends this node compiles for; `shared` nodes register in both. */
  readonly domain: "render" | "behavior" | "shared";
  /** Render: fixed stage, or `"param"` to read it from a `stage` param. */
  readonly stage?: FXRenderStageName | "param";
  /** Behavior: fixed phase, or `"param"` to read it from a `phase` param. */
  readonly phase?: FXBehaviorPhaseName | "param";
  /**
   * Behavior: when `true`, `phase` is only a default - the compiler may place the node
   * in whichever phase the graph wires it into (see `resolvePlacementPhases`). For a
   * value-only node with no real phase constraint, e.g. `spawn-box`.
   */
  readonly phaseFlexible?: boolean;
  /** Palette group (fixed vocabulary - see {@link FXNodeCategory}). */
  readonly category: FXNodeCategory;
  /**
   * Type-polymorphism declaration: present iff any socket is typed `"T"`. A node whose `T`
   * is not inferable from a connected generic input (a `constant`/`combine` source) must
   * also carry a structural `valueType` param as the explicit annotation.
   */
  readonly generic?: { readonly constraint: readonly FXGLSLTypeName[] };
  readonly inputs: I;
  readonly outputs: Readonly<Record<string, FXSocketSpec>>;
  readonly params: P;
  /**
   * Target inputs {@link build} reads via `target.read(...)` - explicit reads only; an
   * input socket's target-input default is folded in automatically. A function form is for
   * a read keyed off a structural param (e.g. `read-state`'s `builtin` enum). Surfaces as
   * {@link FXGraphNode.targetReads}; the contract test verifies it covers every actual read.
   */
  readonly reads?:
    readonly string[] | ((params: Readonly<Record<string, unknown>>) => readonly string[]);
  /**
   * The lighting intrinsic this node emits ({@link FXGraphNode.lightingIntrinsic}) - a runtime
   * `fx_` ABI function called via `fn.raw` but never defined here. Omit for a non-lighting node.
   */
  readonly lightingIntrinsic?: string;
  /**
   * Static complexity estimate (see {@link FXGraphNode.estimateCost}): a flat number, or a
   * function of current params/resolved type. Roughly "one scalar float ALU op" per unit;
   * `0` for a compile-time literal or pure reshuffle (`constant`, `split`, `combine`, ...).
   */
  readonly cost: FXNodeCost;
  /** Pure code builder: reads inputs/params as IR, returns an output expression per output key. */
  readonly build: (args: {
    inputs: FXResolvedInputs<I>;
    params: FXResolvedParams<P>;
    /** The node's resolved generic type `T` - only meaningful for a generic node. */
    resolvedT: FXValueType;
    target: { read: (name: string) => FXExpr };
    /** Materializes a shared sub-expression into an SSA local (reused across outputs/components). */
    local: (hint: string, expr: FXExpr) => FXExpr;
    /** Emits a deduplicated JS/GLSL helper - escape hatch for a helper used by a single node. */
    emitHelper: (key: string, source: string) => void;
    fn: FXExprBuilderApi;
  }) => Record<string, FXExpr>;
  /**
   * Render-only: an alternate `build` the baseline (WebGL1) compiler prefers when present, for a
   * node whose primary `build` reaches for a WebGL2-only capability (a `standardOnly` function, an
   * `int`-family value) it cannot offer as-is under GLSL ES 1.00. A hand-authored simplified
   * algorithm is written exactly like `build` - same shape, real logic (or a plain passthrough
   * that reads an input and returns it as an output). Omit when the primary `build` never
   * reaches for a standard-only capability; `FXCompilerStandard` never looks at this field at all.
   */
  readonly baselineBuild?: FXNodeDescriptor<P, I>["build"];
}

/** The runtime handle produced by {@link defineNode}; wraps into per-backend registry factories. */
export interface FXNodeDefinition {
  readonly type: string;
  readonly domain: "render" | "behavior" | "shared";
  readonly params: Readonly<Record<string, FXParamSpec>>;
  /** Builds a fresh node instance for `backend`, applying optional serialized params. */
  createInstance(backend: FXNodeBackend, params?: Readonly<Record<string, unknown>>): FXGraphNode;
  /** JSON-serializable metadata for the editor palette / inspector. */
  describe(): FXNodeMeta;
}

function isTargetInputDefault(value: unknown): value is FXTargetInputDefault {
  // `typeof null === "object"` too; `!value` excludes exactly that case without writing the
  // banned null literal.
  if (typeof value !== "object" || !value) {
    return false;
  }
  return "targetInput" in value;
}

/**
 * Serializes an input socket's `default` for {@link FXSocketMeta.default}: a literal to
 * its value, a target-input reference to `{ targetInput }`, anything else omitted (a
 * non-literal IR expr default has nothing serializable to show).
 */
function socketDefaultMeta(value: FXSocketSpec["default"]): FXSocketMeta["default"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isTargetInputDefault(value)) {
    return { targetInput: value.targetInput };
  }
  if (value.kind === "lit") {
    return value.values.length === 1 ? value.values[0] : [...value.values];
  }
  return undefined;
}

/** Serializes an input socket's editable inline default (`value` + hints) for the editor. */
function socketControlMeta(specification: FXSocketSpec): FXSocketMeta["control"] | undefined {
  if (specification.value === undefined) {
    return undefined;
  }
  return {
    default: specification.value,
    ...(specification.min !== undefined ? { min: specification.min } : {}),
    ...(specification.max !== undefined ? { max: specification.max } : {}),
    ...(specification.step !== undefined ? { step: specification.step } : {}),
    ...(specification.color !== undefined ? { color: specification.color } : {}),
  };
}

function toSocketMeta(
  specifications: Readonly<Record<string, FXSocketSpec>>,
): readonly FXSocketMeta[] {
  return Object.entries(specifications).map(([key, specification]) => {
    const defaultValue = socketDefaultMeta(specification.default);
    const control = socketControlMeta(specification);
    return {
      key,
      type: specification.type,
      ...(specification.label !== undefined ? { label: specification.label } : {}),
      ...(specification.description !== undefined
        ? { description: specification.description }
        : {}),
      ...(specification.required !== undefined ? { required: specification.required } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(control !== undefined ? { control } : {}),
    };
  });
}

/** Target inputs a node reads via an input socket's `targetInput` default (static). */
function inputDefaultReads(inputs: Readonly<Record<string, FXSocketSpec>>): readonly string[] {
  const reads: string[] = [];
  for (const specification of Object.values(inputs)) {
    if (isTargetInputDefault(specification.default)) {
      reads.push(specification.default.targetInput);
    }
  }
  return reads;
}

/**
 * Static read superset for {@link FXNodeMeta.reads} (palette filtering) - broader than
 * the instance-exact {@link FXGraphNode.targetReads}. A function-form `reads` is evaluated
 * once per structural-param option, one param at a time (not a full Cartesian product) and
 * only over structural params, not value params; falls back to `"dynamic"` if it throws.
 */
function describeReads(
  descriptor: FXNodeDescriptor<Record<string, FXParamSpec>>,
): readonly string[] | "dynamic" {
  const superset = new Set<string>(inputDefaultReads(descriptor.inputs));
  const reads = descriptor.reads;
  if (reads === undefined) {
    return [...superset];
  }
  if (typeof reads !== "function") {
    for (const name of reads) {
      superset.add(name);
    }
    return [...superset];
  }

  const defaults: Record<string, unknown> = {};
  for (const [key, specification] of Object.entries(descriptor.params)) {
    defaults[key] = specification.default;
  }
  const variants: Record<string, unknown>[] = [{ ...defaults }];
  for (const [key, specification] of Object.entries(descriptor.params)) {
    const options: readonly unknown[] | undefined =
      specification.type === "enum" || specification.type === "valueType"
        ? specification.options
        : specification.type === "flag"
          ? [true, false]
          : undefined;
    if (options === undefined) {
      continue;
    }
    for (const option of options) {
      variants.push({ ...defaults, [key]: option });
    }
  }
  try {
    for (const variant of variants) {
      for (const name of reads(variant)) {
        superset.add(name);
      }
    }
  } catch {
    return "dynamic";
  }
  return [...superset];
}

/**
 * The palette-facing baseline for {@link FXNodeMeta.cost}: the descriptor's cost evaluated at
 * its params' declared defaults and the narrowest resolved type in scope (see
 * {@link narrowestGenericType}) - a generic node's baseline reads as its cheapest case; the true
 * per-instance cost only grows from there as `T` resolves wider or params move off their defaults.
 */
function describeCost(descriptor: FXNodeDescriptor<Record<string, FXParamSpec>>): number {
  if (typeof descriptor.cost === "number") {
    return descriptor.cost;
  }
  const parameters: Record<string, unknown> = {};
  for (const [key, specification] of Object.entries(descriptor.params)) {
    parameters[key] = specification.default;
  }
  return descriptor.cost({
    params: parameters,
    resolvedT: narrowestGenericType(descriptor.generic?.constraint),
  });
}

/** Whether any socket specification is typed as the generic variable `"T"`. */
function hasGenericSocketSpec(descriptor: FXNodeDescriptor<Record<string, FXParamSpec>>): boolean {
  const all = [...Object.values(descriptor.inputs), ...Object.values(descriptor.outputs)];
  return all.some((specification) => specification.type === "T");
}

/** A socket key must be a plain identifier - it is spliced into space-joined map keys. */
const SOCKET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Component count a vecN value-param default must have (2, 3, or 4). */
const VEC_WIDTH = { vec2: 2, vec3: 3, vec4: 4 } as const;

/**
 * Turns a declarative {@link FXNodeDescriptor} into an {@link FXNodeDefinition}:
 * a factory of live node instances plus editor metadata. This is the single entry
 * point for authoring a standard (non-resource) node.
 */
export function defineNode<
  P extends Record<string, FXParamSpec>,
  I extends Record<string, FXSocketSpec>,
>(descriptor: FXNodeDescriptor<P, I>): FXNodeDefinition {
  const isGeneric = hasGenericSocketSpec(
    descriptor as FXNodeDescriptor<Record<string, FXParamSpec>>,
  );
  if (isGeneric && descriptor.generic === undefined) {
    throw new Error(
      `defineNode("${descriptor.type}"): a node with a "T" socket must declare its generic constraint`,
    );
  }
  // A `"param"` node reads `params["stage"]`/`params["phase"]` directly in applyParams,
  // so a descriptor must not also declare its own param under those keys (collision).
  if (descriptor.stage === "param" && "stage" in descriptor.params) {
    throw new Error(`defineNode("${descriptor.type}"): "stage" is reserved for a stage-param node`);
  }
  if (descriptor.phase === "param" && "phase" in descriptor.params) {
    throw new Error(`defineNode("${descriptor.type}"): "phase" is reserved for a phase-param node`);
  }
  // A param name and an editable input socket key both live in the instance's `values` map
  // keyed by name, so a collision silently overwrites one with the other - the `cacheKey`
  // `s`/`i` tags hash them apart but the stored value is shared. Reject it at define time.
  for (const [key, specification] of Object.entries(descriptor.inputs)) {
    if (specification.value !== undefined && key in descriptor.params) {
      throw new Error(
        `defineNode("${descriptor.type}"): "${key}" is both a param and an editable input socket; their live values would collide`,
      );
    }
  }
  // Socket keys are joined into map keys by a space separator (`socketRefKey`), which
  // stays injective only if a key never contains whitespace - enforce that at define time.
  for (const key of [...Object.keys(descriptor.inputs), ...Object.keys(descriptor.outputs)]) {
    if (!SOCKET_KEY_PATTERN.test(key)) {
      throw new Error(
        `defineNode("${descriptor.type}"): socket key "${key}" must be an identifier ([A-Za-z_][A-Za-z0-9_]*)`,
      );
    }
  }
  // Editable inline socket defaults (`value`) are inputs-only, exclusive with the static
  // `default`, and must match the socket's width for a concrete vecN.
  for (const [key, specification] of Object.entries(descriptor.outputs)) {
    if (specification.value !== undefined) {
      throw new Error(
        `defineNode("${descriptor.type}"): output socket "${key}" cannot carry an editable "value"`,
      );
    }
  }
  for (const [key, specification] of Object.entries(descriptor.inputs)) {
    if (specification.value === undefined) {
      continue;
    }
    if (specification.default !== undefined) {
      throw new Error(
        `defineNode("${descriptor.type}"): input socket "${key}" cannot declare both "value" (editable) and "default" (static)`,
      );
    }
    if (specification.type === "float" || specification.type === "T") {
      // A float takes a scalar; a generic seed may be a scalar or a vector (its width is
      // resolved per instance), so only reject a non-finite / malformed shape here.
      if (specification.type === "float" && typeof specification.value !== "number") {
        throw new Error(
          `defineNode("${descriptor.type}"): input socket "${key}" (float) expects a numeric "value"`,
        );
      }
      continue;
    }
    if (
      specification.type !== "vec2" &&
      specification.type !== "vec3" &&
      specification.type !== "vec4"
    ) {
      // An opaque type (mat3/sampler2D) cannot be a "value on the pin" - a texture is picked, not typed.
      throw new Error(
        `defineNode("${descriptor.type}"): input socket "${key}" (${specification.type}) cannot carry an editable "value"`,
      );
    }
    const width = VEC_WIDTH[specification.type];
    if (!Array.isArray(specification.value) || specification.value.length !== width) {
      throw new Error(
        `defineNode("${descriptor.type}"): input socket "${key}" is ${specification.type} but its "value" has ` +
          `${(Array.isArray(specification.value) ? specification.value.length : 1).toString()} components (expected ${width.toString()})`,
      );
    }
  }
  // A vecN value param's default must match its declared width, else coerce would
  // silently accept the wrong width later.
  for (const [name, specification] of Object.entries(descriptor.params)) {
    if (
      specification.type !== "vec2" &&
      specification.type !== "vec3" &&
      specification.type !== "vec4"
    ) {
      continue;
    }
    const width = VEC_WIDTH[specification.type];
    if (specification.default.length !== width) {
      throw new Error(
        `defineNode("${descriptor.type}"): value param "${name}" is ${specification.type} but its default has ` +
          `${specification.default.length.toString()} components (expected ${width.toString()})`,
      );
    }
  }

  const core = {
    type: descriptor.type,
    domain: descriptor.domain,
    ...(descriptor.stage !== undefined ? { stage: descriptor.stage } : {}),
    ...(descriptor.phase !== undefined ? { phase: descriptor.phase } : {}),
    ...(descriptor.phaseFlexible !== undefined ? { phaseFlexible: descriptor.phaseFlexible } : {}),
    ...(descriptor.generic?.constraint !== undefined
      ? { constraint: descriptor.generic.constraint }
      : {}),
    inputSpecs: descriptor.inputs,
    outputSpecs: descriptor.outputs,
    params: descriptor.params,
    ...(descriptor.reads !== undefined ? { reads: descriptor.reads } : {}),
    ...(descriptor.lightingIntrinsic !== undefined
      ? { lightingIntrinsic: descriptor.lightingIntrinsic }
      : {}),
    cost: descriptor.cost,
    build: descriptor.build as unknown as FXDescriptorBuild,
    ...(descriptor.baselineBuild !== undefined
      ? { baselineBuild: descriptor.baselineBuild as unknown as FXDescriptorBuild }
      : {}),
  };

  function assertBackend(backend: FXNodeBackend): void {
    if (descriptor.domain !== "shared" && descriptor.domain !== backend) {
      throw new Error(
        `FXNodeDefinition("${descriptor.type}"): a ${descriptor.domain} node cannot be created for the ${backend} backend`,
      );
    }
  }

  return {
    type: descriptor.type,
    domain: descriptor.domain,
    params: descriptor.params,
    createInstance(
      backend: FXNodeBackend,
      parameters?: Readonly<Record<string, unknown>>,
    ): FXGraphNode {
      assertBackend(backend);
      return new FXDescriptorNode(core, parameters);
    },
    describe(): FXNodeMeta {
      // A `stage: "param"` / `phase: "param"` node has no user-facing placement param - the
      // compiler infers it from the graph. The constraint still rides `metadata.stage`/`metadata.phase`
      // below for palette filtering; it just is not an editable parameter.
      const parameters: Record<string, FXParamMeta> = { ...descriptor.params };
      // Deep-frozen: the returned metadata shares references with the live param schema the
      // coerce path reads, so a mutating consumer must fail loudly, not corrupt it.
      return deepFreeze({
        type: descriptor.type,
        category: descriptor.category,
        domain: descriptor.domain,
        inputs: toSocketMeta(descriptor.inputs),
        outputs: toSocketMeta(descriptor.outputs),
        params: parameters,
        reads: describeReads(descriptor as FXNodeDescriptor<Record<string, FXParamSpec>>),
        cost: describeCost(descriptor as FXNodeDescriptor<Record<string, FXParamSpec>>),
        ...(descriptor.stage !== undefined ? { stage: descriptor.stage } : {}),
        ...(descriptor.phase !== undefined ? { phase: descriptor.phase } : {}),
        ...(descriptor.generic !== undefined ? { generic: descriptor.generic } : {}),
      });
    },
  };
}
