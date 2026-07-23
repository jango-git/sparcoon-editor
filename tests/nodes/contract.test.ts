import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXNodeDefinition } from "../../src/engine/core/nodes/defineNode";
import type { FXParamSpec } from "../../src/engine/core/nodes/FXParamSpec";
import { FX_STANDARD_NODES } from "../../src/engine/nodes-std/index";
import type { FXGraphNode } from "../../src/engine/core/FXGraphNode";
import type { FXSocketDescriptor } from "../../src/engine/core/socket/FXSocket";
import type { FXGLSLTypeName, FXValueType } from "../../src/engine/core/socket/FXValueType";
import {
  FX_VALUE_TYPES,
  isGenericType,
  isMatrixType,
  resolveValueType,
} from "../../src/engine/core/socket/FXValueType";
import { construct, lit, swizzle } from "../../src/engine/core/ir/FXExprBuilder";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  compileParticleBehavior,
  previewParticleBehaviorHash,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXCompiledKernel } from "../../src/engine/behavior/FXCompiledKernel";
import { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import type { FXRenderContext } from "../../src/engine/render/compiler/FXRenderContext";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXTarget } from "../../src/engine/render/target/FXTarget";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { isFXCompilerErrorException } from "../../src/engine/core/compiler/FXCompilerError";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";

const VEC4 = FX_VALUE_TYPES.vec4;

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}
function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

function backendOf(def: FXNodeDefinition): "render" | "behavior" {
  return def.domain === "render" ? "render" : "behavior";
}

/**
 * Whether any of a node's sockets carries a matrix type (concrete, or a generic `T`
 * constrained to matrices). The generic compile harness feeds required inputs from a
 * `constant` (which has no matrix form) and binds outputs to vec slots, so it cannot
 * synthesize a minimal graph for a matrix node - those are covered by the dedicated
 * `stdRenderMatrix.test.ts` with hand-built graphs instead.
 */
function usesMatrixType(def: FXNodeDefinition): boolean {
  const node = def.createInstance(backendOf(def));
  for (const socket of [...node.inputs, ...node.outputs]) {
    if (isGenericType(socket.type)) {
      if (socket.type.constraint.some((name) => isMatrixType(resolveValueType(name)))) {
        return true;
      }
    } else if (isMatrixType(socket.type)) {
      return true;
    }
  }
  return false;
}

/** A distinct-but-valid value for a param, used to prove the recompile/rebind gate. */
function distinctValue(spec: FXParamSpec): unknown {
  switch (spec.type) {
    case "float": {
      const up = spec.default + 1;
      if (spec.max !== undefined && up > spec.max) {
        return spec.default - 1;
      }
      return up;
    }
    case "vec2":
    case "vec3":
    case "vec4": {
      const arr = [...spec.default];
      arr[0] += 1;
      return arr;
    }
    case "generic": {
      if (typeof spec.default === "number") {
        return spec.default + 1;
      }
      const arr = [...spec.default];
      arr[0] += 1;
      return arr;
    }
    case "curve":
      return {
        points: [
          ...spec.default.points,
          { position: 0.5, value: 0.5, interpolation: "smooth" as const },
        ],
      };
    case "gradient":
      return {
        stops: [...spec.default.stops, { position: 0.5, color: [0.5, 0.5, 0.5, 1] }],
      };
    case "enum":
    case "valueType":
      return spec.options.find((o) => o !== spec.default) ?? spec.default;
    case "flag":
      return !spec.default;
  }
}

function defaultParams(def: FXNodeDefinition): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(def.params)) {
    params[name] = spec.default;
  }
  return params;
}

/** A distinct-but-valid value for an editable input's inline default (the "value on the pin"). */
function distinctControlValue(control: {
  default: number | readonly number[];
  min?: number;
  max?: number;
}): unknown {
  const value = control.default;
  if (typeof value === "number") {
    // Prefer default+1; if that exceeds max, try default-1; if that underflows min, fall back
    // to whichever bound differs from the default (a distinct, in-range value). Scalars are
    // bounds-checked on coerce, so the chosen value must stay within [min, max].
    const up = value + 1;
    if (control.max === undefined || up <= control.max) {
      return up;
    }
    const down = value - 1;
    if (control.min === undefined || down >= control.min) {
      return down;
    }
    return value === control.max ? control.min : control.max;
  }
  const arr = [...value];
  arr[0] += 1;
  return arr;
}

// --- Generic-node helpers: pick a representative `T` and size feeds/slots to it ---

/** The generic constraint carried by any of the node's `"T"` sockets, if generic. */
function genericConstraint(node: FXGraphNode): readonly FXGLSLTypeName[] | undefined {
  for (const socket of [...node.inputs, ...node.outputs]) {
    if (isGenericType(socket.type)) {
      return socket.type.constraint;
    }
  }
  return undefined;
}

/** A representative concrete `T` to exercise: `float` when allowed, else `vec3`, else first. */
function pickTargetT(constraint: readonly FXGLSLTypeName[]): FXGLSLTypeName {
  if (constraint.includes("float")) {
    return "float";
  }
  if (constraint.includes("vec3")) {
    return "vec3";
  }
  return constraint[0];
}

/** A zero value of the given width - a valid `constant` payload to feed a socket. */
function zeroValue(typeName: FXGLSLTypeName): number | number[] {
  const components = FX_VALUE_TYPES[typeName].components;
  return components === 1 ? 0 : new Array<number>(components).fill(0);
}

/** Concrete type a socket carries once the node's `T` is `targetT` (or its own annotation). */
function concreteSocketType(
  node: FXGraphNode,
  socket: FXSocketDescriptor,
  targetT: FXGLSLTypeName | undefined,
): FXValueType {
  if (!isGenericType(socket.type)) {
    return socket.type;
  }
  const resolved = node.resolveGenericHint?.() ?? targetT ?? "float";
  return resolveValueType(resolved);
}

// --- Render compile harness: adapts any node output to a bindable slot ---------

/** Fragment stub that adapts a value of any type into a bindable `vec4` albedo. */
class StubConsumer extends FXRenderNode {
  public readonly type = "stub-consumer";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs;
  public readonly outputs = [{ key: "color", type: VEC4 }];

  constructor(private readonly inType: FXValueType) {
    super();
    this.inputs = [{ key: "x", type: inType, required: true }];
  }

  public build(ctx: FXRenderContext): void {
    const x = ctx.readInput("x");
    const c = this.inType.components;
    const expr =
      c === 1
        ? construct(VEC4, x, x, x, x)
        : c === 2
          ? construct(VEC4, swizzle(x, "x"), swizzle(x, "y"), lit(0), lit(1))
          : c === 3
            ? construct(VEC4, swizzle(x, "x"), swizzle(x, "y"), swizzle(x, "z"), lit(1))
            : x;
    ctx.setOutput("color", expr);
  }
}

interface BehaviorHarness {
  graph: FXGraph<FXBehaviorNode>;
  node: FXBehaviorNode;
  hash: () => string;
  compile: () => FXCompiledKernel;
}

function behaviorHarness(
  def: FXNodeDefinition,
  params?: Record<string, unknown>,
  forceT?: FXGLSLTypeName,
): BehaviorHarness {
  const reg = behaviorRegistry();
  const node = reg.create(def.type, params);
  const phase = node.phase;
  const constraint = genericConstraint(node);
  const targetT = forceT ?? (constraint !== undefined ? pickTargetT(constraint) : undefined);
  const nodes = new Map<string, FXBehaviorNode>([["n", node]]);
  const connections: FXConnection[] = [];
  let stub = 0;
  for (const socket of node.inputs) {
    if (socket.required === true) {
      // Feed a `constant` of the socket's concrete type (its `T` unifies to targetT).
      const id = `stub${stub++}`;
      const typeName = concreteSocketType(node, socket, targetT).glslTypeName;
      nodes.set(id, reg.create("constant", { type: typeName, value: zeroValue(typeName), phase }));
      connections.push(edge(id, "out", "n", socket.key));
    }
  }
  const out = node.outputs[0];
  const outComponents = concreteSocketType(node, out, targetT).components;
  const graph = new FXGraph<FXBehaviorNode>();
  // Bind the node's first output to a core write slot of matching width so any node
  // compiles in a minimal graph: a scalar lands in `positionX`, a vec3 in `position`
  // (both are core, both-phase). A vec4 (a color) has no core write slot, so split off its
  // rgb (vec3) through a Split Color node and bind that. The contract test checks
  // compilability, not semantics - a force's velocity is normally wired to a `store-attribute`.
  if (outComponents === 4) {
    nodes.set("splitOut", reg.create("split-color", { phase }));
    connections.push(edge("n", out.key, "splitOut", "color"));
    graph.ingest({ nodes, connections, outputBindings: [bind("position", "splitOut", "rgb")] });
  } else {
    const slot = outComponents === 1 ? "positionX" : "position";
    graph.ingest({ nodes, connections, outputBindings: [bind(slot, "n", out.key)] });
  }
  return {
    graph,
    node,
    hash: () => previewParticleBehaviorHash(graph),
    compile: () => compileParticleBehavior(graph),
  };
}

interface RenderHarness {
  graph: FXGraph<FXRenderNode>;
  node: FXRenderNode;
  target: FXTarget;
  hash: () => string;
  compile: () => ReturnType<FXCompilerBaseline["compile"]>;
}

function renderHarness(
  def: FXNodeDefinition,
  params?: Record<string, unknown>,
  forceT?: FXGLSLTypeName,
): RenderHarness {
  const reg = renderRegistry();
  const compiler = new FXCompilerBaseline();
  const node = reg.create(def.type, params);
  const constraint = genericConstraint(node);
  const targetT = forceT ?? (constraint !== undefined ? pickTargetT(constraint) : undefined);
  const out = node.outputs[0];
  const outType = concreteSocketType(node, out, targetT);
  const nodes = new Map<string, FXRenderNode>([["n", node]]);
  const connections: FXConnection[] = [];
  let stub = 0;
  for (const socket of node.inputs) {
    if (socket.required === true) {
      // Feed a `constant` of the socket's concrete type (its `T` unifies to targetT).
      const id = `stub${stub++}`;
      const typeName = concreteSocketType(node, socket, targetT).glslTypeName;
      nodes.set(id, reg.create("constant", { type: typeName, value: zeroValue(typeName) }));
      connections.push(edge(id, "out", "n", socket.key));
    }
  }

  const target: FXTarget = FX_PARTICLE_TARGET;
  const outputBindings: FXOutputBinding[] = [];
  const components = outType.components;
  if (components === 4) {
    outputBindings.push(bind("albedo", "n", out.key));
  } else {
    // Non-vec4 outputs (a normal, a scalar, a matrix) have no surface slot; funnel through a
    // stub consumer that packs the value into the required vec4 albedo, keeping the node reachable.
    nodes.set("consumer", new StubConsumer(outType));
    connections.push(edge("n", out.key, "consumer", "x"));
    outputBindings.push(bind("albedo", "consumer", "color"));
  }

  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({ nodes, connections, outputBindings });
  return {
    graph,
    node,
    target,
    hash: () => compiler.previewHash(graph, target),
    compile: () => compiler.compile(graph, target),
  };
}

/**
 * Compiles a node in its minimal harness while recording every target input its
 * `build` reads through the compiler context (`readTargetInput`), so the anti-rot
 * check can prove the declared {@link FXGraphNode.targetReads} covers every actual
 * read. Optional inputs with a `targetInput` default are left unconnected here, so
 * those defaults are exercised too - the declared set must still include them.
 */
function recordedTargetReads(def: FXNodeDefinition): {
  actual: readonly string[];
  declared: readonly string[] | undefined;
} {
  const actual: string[] = [];
  const harness = backendOf(def) === "behavior" ? behaviorHarness(def) : renderHarness(def);
  const node = harness.node as unknown as {
    build: (ctx: object) => void;
    targetReads?: readonly string[];
  };
  const declared = node.targetReads;
  const original = node.build.bind(node);
  node.build = (ctx: object): void => {
    const proxy = new Proxy(ctx, {
      get(here, prop, receiver): unknown {
        if (prop === "readTargetInput") {
          return (name: string): unknown => {
            actual.push(name);
            return (Reflect.get(here, prop, receiver) as (n: string) => unknown).call(here, name);
          };
        }
        const value = Reflect.get(here, prop, receiver);
        return typeof value === "function" ? value.bind(here) : value;
      },
    });
    original(proxy);
  };
  harness.compile();
  return { actual, declared };
}

// --- The parameterized contract, run for every standard node definition --------

describe("standard node contract", () => {
  for (const def of FX_STANDARD_NODES) {
    describe(def.type, () => {
      const backend = backendOf(def);

      it("describe() is JSON-serializable", () => {
        expect(() => JSON.stringify(def.describe())).not.toThrow();
      });

      it("exposes a category for the palette", () => {
        const meta = def.describe();
        expect(meta.category).toBeTruthy();
      });

      // Placement (stage/phase) is INFERRED by the compiler from the graph, so a
      // param-stage/phase node exposes no editable stage/phase param - the editor shows
      // only its real params (`constant` -> type + value). The constraint still rides
      // meta.stage / meta.phase for palette filtering; applyParams still tolerates and
      // validates a placement value (an older snapshot may carry one).
      const stageIsParam = def.describe().stage === "param";
      const phaseIsParam = def.describe().phase === "param";
      if (stageIsParam) {
        it("does not expose stage as an editable param (placement is inferred)", () => {
          expect(def.describe().params["stage"]).toBeUndefined();
          const node = def.createInstance(backend);
          expect(() => node.applyParams?.({ stage: "vertex" })).not.toThrow();
          expect(() => node.applyParams?.({ stage: "nonsense" })).toThrow(/FXNodeDefinition/);
        });
      }
      if (phaseIsParam) {
        it("does not expose phase as an editable param (placement is inferred)", () => {
          expect(def.describe().params["phase"]).toBeUndefined();
          const node = def.createInstance(backend);
          expect(() => node.applyParams?.({ phase: "spawn" })).not.toThrow();
          expect(() => node.applyParams?.({ phase: "nonsense" })).toThrow(/FXNodeDefinition/);
        });
      }

      it("stage/phase meta agree with domain (M4/M5)", () => {
        const meta = def.describe();
        // A render/shared node carries a stage; a behavior/shared node carries a
        // phase - the editor's mechanical filter for an update-only / vertex target.
        if (backend === "behavior") {
          expect(meta.phase).toBeDefined();
        }
        if (def.domain !== "behavior") {
          expect(meta.stage).toBeDefined();
        }
        if (def.domain === "behavior") {
          expect(meta.stage).toBeUndefined();
        }
        if (def.domain === "render") {
          expect(meta.phase).toBeUndefined();
        }
      });

      it("applyParams(defaults) is idempotent and does not throw", () => {
        const node = def.createInstance(backend);
        const before = node.cacheKey?.() ?? "";
        expect(() => node.applyParams?.(defaultParams(def))).not.toThrow();
        expect(node.cacheKey?.() ?? "").toBe(before);
      });

      const firstParam = Object.keys(def.params)[0];
      // Genuinely undefined for a param-less node definition, not a
      // noUncheckedIndexedAccess artifact - skips this block when there is no param
      // to corrupt.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (firstParam !== undefined) {
        it("rejects a garbage param with a clear error", () => {
          const node = def.createInstance(backend);
          expect(() => node.applyParams?.({ [firstParam]: { junk: true } })).toThrow(
            /FXNodeDefinition/,
          );
        });
      }

      for (const [name, spec] of Object.entries(def.params)) {
        if (spec.kind === "structural") {
          it(`structural param "${name}" moves the cacheKey`, () => {
            const node = def.createInstance(backend);
            const before = node.cacheKey?.() ?? "";
            node.applyParams?.({ [name]: distinctValue(spec) });
            expect(node.cacheKey?.() ?? "").not.toBe(before);
          });
        } else {
          it(`value param "${name}" keeps the cacheKey`, () => {
            const node = def.createInstance(backend);
            const before = node.cacheKey?.() ?? "";
            node.applyParams?.({ [name]: distinctValue(spec) });
            expect(node.cacheKey?.() ?? "").toBe(before);
          });
        }
      }

      // Matrix nodes cannot be synthesized by the generic compile harness (no matrix
      // `constant` to feed inputs, no vec slot to bind a matrix output) - the two
      // compile-based checks below run only for non-matrix nodes; matrix compilation is
      // exercised directly in stdRenderMatrix.test.ts.
      const involvesMatrix = usesMatrixType(def);

      if (!involvesMatrix) {
        it("declares target reads that cover every actual read", () => {
          const { actual, declared } = recordedTargetReads(def);
          // Every standard node declares its reads (concrete array, never undefined),
          // so validation never has to skip it.
          expect(declared).toBeDefined();
          for (const name of actual) {
            expect(declared).toContain(name);
          }
        });
      }

      it("describe().reads is a superset of the instance's declared reads", () => {
        const meta = def.describe();
        // "dynamic" is the editor's show-and-validate-on-apply escape; standard
        // nodes resolve to a concrete superset (used for palette filtering).
        expect(meta.reads).not.toBe("dynamic");
        const node = def.createInstance(backend);
        for (const name of node.targetReads ?? []) {
          expect(meta.reads).toContain(name);
        }
      });

      if (!involvesMatrix) {
        it("compiles in a minimal valid graph", () => {
          if (backend === "behavior") {
            expect(() => behaviorHarness(def).compile()).not.toThrow();
          } else {
            expect(() => renderHarness(def).compile()).not.toThrow();
          }
        });
      }

      // Every enum/valueType OPTION must compile or be rejected with a typed,
      // node-attributed error - never a bare crash. This catches enumxtype gaps the
      // meta advertises but the IR lacks (`binary-op:atan2` on a vector, `unary-op:
      // normalize` on a float) and a `blend` mode with no implementation (M4). Shared
      // generic nodes route through the render harness (it adapts any output width);
      // the T cartesian is the small bindable subset {float, vec3}.
      {
        const probe = def.createInstance(backend);
        const constraint = genericConstraint(probe);
        const pinsTypeItself = Object.values(def.params).some((s) => s.type === "valueType");
        const cartesianTs: readonly (FXGLSLTypeName | undefined)[] =
          constraint !== undefined && !pinsTypeItself
            ? constraint.filter((t) => t === "float" || t === "vec3")
            : [undefined];
        for (const [pname, pspec] of Object.entries(def.params)) {
          if (pspec.type !== "enum" && pspec.type !== "valueType") {
            continue;
          }
          for (const option of pspec.options) {
            // A valueType param sets T itself, so no separate cartesian is needed.
            const ts = pspec.type === "valueType" ? [undefined] : cartesianTs;
            for (const t of ts) {
              const label = `${pname}=${option}${t !== undefined ? ` T=${t}` : ""}`;
              it(`option ${label} compiles or is rejected with a nodeId`, () => {
                // Only the one param - the node reshapes dependent params (a generic
                // `value` widening with `type`) from its own consistent defaults.
                const overrides = { [pname]: option };
                try {
                  if (def.domain === "behavior") {
                    behaviorHarness(def, overrides, t).compile();
                  } else {
                    renderHarness(def, overrides, t).compile();
                  }
                } catch (error) {
                  expect(
                    isFXCompilerErrorException(error),
                    `${label} threw a bare error: ${String(error)}`,
                  ).toBe(true);
                  expect((error as { error: { nodeId?: string } }).error.nodeId).toBeDefined();
                }
              });
            }
          }
        }
      }

      // Editable inputs (the "value on the pin") bake as inline literals - variant A - so
      // editing one MUST move the cacheKey and recompile. This is the counterpart of the
      // structural-param contract above, and replaces the old uniform-backed value param
      // (which rebound in place); uniforms/bindings are now the exclusive domain of param
      // nodes (+ curve LUTs, which still rebind through the `value`/`curve` param above).
      for (const socket of def.describe().inputs) {
        if (socket.control === undefined) {
          continue;
        }
        it(`editing editable input "${socket.key}" moves the cacheKey (inline literal)`, () => {
          const node = def.createInstance(backend);
          const before = node.cacheKey?.() ?? "";
          node.applyParams?.({ [socket.key]: distinctControlValue(socket.control!) });
          expect(node.cacheKey?.() ?? "").not.toBe(before);
        });
      }
    });
  }
});
