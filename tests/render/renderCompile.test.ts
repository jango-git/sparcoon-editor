import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXSocketDescriptor } from "../../src/engine/core/socket/FXSocket";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { add, construct, lit, litVec } from "../../src/engine/core/ir/FXExprBuilder";
import { isFXCompilerErrorException } from "../../src/engine/core/compiler/FXCompilerError";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderContext } from "../../src/engine/render/compiler/FXRenderContext";
import { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { FXRenderNodeTexture } from "../../src/engine/render/nodes/FXRenderNodeTexture";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { renderRegistry } from "../helpers/stdRegistry";

const reg = renderRegistry();

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;
const VEC4 = FX_VALUE_TYPES.vec4;

function graphOf(
  nodes: Record<string, FXRenderNode>,
  connections: readonly FXConnection[],
  outputBindings: readonly FXOutputBinding[],
): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({ nodes: new Map(Object.entries(nodes)), connections, outputBindings });
  return graph;
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

describe("FXCompilerBaseline render golden - UV -> Texture -> Blend", () => {
  const compiler = new FXCompilerBaseline();

  function compiled(): ReturnType<FXCompilerBaseline["compile"]> {
    const uv = reg.create("uv", {});
    const tex = new FXRenderNodeTexture("sheet");
    const blend = reg.create("blend", { mode: "add" });
    const graph = graphOf(
      { uv, tex, blend },
      [
        edge("uv", "uv", "tex", "uv"),
        edge("tex", "color", "blend", "base"),
        edge("tex", "color", "blend", "blend"),
      ],
      [{ slot: "albedo", from: { nodeId: "blend", socketKey: "color" } }],
    );
    return compiler.compile(graph, FX_PARTICLE_TARGET);
  }

  it("binds the albedo slot to a fragment local", () => {
    const shader = compiled();
    expect(shader.outputs["albedo"]).toBeDefined();
    expect(shader.outputs["albedo"]).toMatch(/^\w+_\d+$/);
  });

  it("emits SSA locals into the fragment body", () => {
    const shader = compiled();
    expect(shader.fragment.body.length).toBeGreaterThan(0);
    expect(shader.fragment.body.some((line) => /^\s*vec\d? \w+_\d+ = /.test(line))).toBe(true);
  });

  it("computes a diamond producer exactly once (texture sampled once)", () => {
    const shader = compiled();
    const samples = shader.fragment.body.filter((line) => line.includes("texture2D("));
    expect(samples).toHaveLength(1);
  });
});

/** Fragment node: turns a float into a vec4 and reads the cross-stage `x`. */
class FragScalarToColor extends FXRenderNode {
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [
    { key: "x", type: FLOAT, required: true },
    { key: "base", type: VEC4 },
  ];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "color", type: VEC4 }];

  constructor(public readonly type: string) {
    super();
  }

  public build(ctx: FXRenderContext): void {
    const x = ctx.readInput("x");
    const base = ctx.readInput("base", litVec(0, 0, 0, 0));
    ctx.setOutput("color", add(base, construct(VEC4, x, x, x, x)));
  }
}

/** Vertex node: exposes a builtin as a float, forcing a cross-stage read. */
class VertexScalar extends FXRenderNode {
  public readonly type = "vertex-scalar";
  public readonly stage = FXShaderStage.VERTEX;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "value", type: FLOAT }];

  public build(ctx: FXRenderContext): void {
    ctx.setOutput("value", ctx.readTargetInput("PARTICLE_POSITION_X"));
  }
}

describe("FXCompilerBaseline render golden - cross-stage varyings", () => {
  it("allocates exactly one varying for a vertex producer read by two fragment consumers", () => {
    const src = new VertexScalar();
    const fragA = new FragScalarToColor("frag-a");
    const fragB = new FragScalarToColor("frag-b");
    const graph = graphOf(
      { src, fragA, fragB },
      [
        edge("src", "value", "fragA", "x"),
        edge("src", "value", "fragB", "x"),
        edge("fragB", "color", "fragA", "base"),
      ],
      [{ slot: "albedo", from: { nodeId: "fragA", socketKey: "color" } }],
    );

    const shader = new FXCompilerBaseline().compile(graph, FX_PARTICLE_TARGET);

    expect(shader.vertex.varyingDeclarations).toHaveLength(1);
  });
});

/** Fragment node declaring an `out` it never fills in build() (a third-party bug). */
class UnfilledAlbedo extends FXRenderNode {
  public readonly type = "unfilled-albedo";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "out", type: VEC4 }];
  public build(): void {
    // Never calls ctx.setOutput("out", ...).
  }
}

/** Fragment node that illegally allocates a varying (varyings are produced in vertex). */
class FragmentVaryingAlloc extends FXRenderNode {
  public readonly type = "frag-varying-alloc";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "out", type: VEC4 }];
  public build(ctx: FXRenderContext): void {
    ctx.allocateVarying(VEC3, "bad");
    ctx.setOutput("out", construct(VEC4, litVec(0, 0, 0), lit(1)));
  }
}

describe("compile-pipeline contract failures (audit-4 R3/R5)", () => {
  const compiler = new FXCompilerBaseline();

  it("R3: a bound output the producer never emitted fails as typed output-not-produced", () => {
    const graph = graphOf(
      { a: new UnfilledAlbedo() },
      [],
      [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
    );
    let caught: unknown;
    try {
      compiler.compile(graph, FX_PARTICLE_TARGET);
    } catch (error) {
      caught = error;
    }
    expect(isFXCompilerErrorException(caught)).toBe(true);
    if (isFXCompilerErrorException(caught)) {
      expect(caught.error.code).toBe("output-not-produced");
      expect(caught.error.nodeId).toBe("a");
      expect(caught.error.slot).toBe("albedo");
    }
  });

  it("R5: allocateVarying from a fragment node fails as varying-from-fragment-stage", () => {
    const graph = graphOf(
      { a: new FragmentVaryingAlloc() },
      [],
      [{ slot: "albedo", from: { nodeId: "a", socketKey: "out" } }],
    );
    let caught: unknown;
    try {
      compiler.compile(graph, FX_PARTICLE_TARGET);
    } catch (error) {
      caught = error;
    }
    expect(isFXCompilerErrorException(caught)).toBe(true);
    if (isFXCompilerErrorException(caught)) {
      expect(caught.error.code).toBe("varying-from-fragment-stage");
      expect(caught.error.nodeId).toBe("a");
    }
  });
});

/** Fragment node emitting a constant vec3. */
class FragVec3 extends FXRenderNode {
  public readonly type = "frag-vec3";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "v", type: VEC3 }];

  public build(ctx: FXRenderContext): void {
    ctx.setOutput("v", litVec(1, 2, 3));
  }
}

describe("numeric coercion across connections", () => {
  const compiler = new FXCompilerBaseline();

  it("narrows a vec3 producer feeding a float input to its first component", () => {
    const src = new FragVec3();
    const frag = new FragScalarToColor("frag");
    const graph = graphOf(
      { src, frag },
      [edge("src", "v", "frag", "x")],
      [{ slot: "albedo", from: { nodeId: "frag", socketKey: "color" } }],
    );

    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);

    // The float input reads the vec3's first component (`.x`) - the connection compiles
    // instead of being rejected as a type mismatch.
    expect(shader.fragment.body.some((line) => line.includes(").x"))).toBe(true);
  });

  it("pads a vec3 producer bound to the vec4 albedo slot with zero", () => {
    const src = new FragVec3();
    const graph = graphOf(
      { src },
      [],
      [{ slot: "albedo", from: { nodeId: "src", socketKey: "v" } }],
    );

    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);

    const slot = shader.outputs["albedo"];
    expect(
      shader.fragment.body.some(
        (line) => line.includes(`vec4 ${slot} =`) && /vec4\(\w+_\d+, 0\.0\)/.test(line),
      ),
    ).toBe(true);
  });
});
