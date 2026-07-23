import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXSocketDescriptor } from "../../src/engine/core/socket/FXSocket";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { construct, lit, litVec, ref } from "../../src/engine/core/ir/FXExprBuilder";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderContext } from "../../src/engine/render/compiler/FXRenderContext";
import { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";

const VEC3 = FX_VALUE_TYPES.vec3;
const VEC4 = FX_VALUE_TYPES.vec4;

/** Emits a constant vec3 in a fixed stage. */
class SourceVec3 extends FXRenderNode {
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "out", type: VEC3 }];
  constructor(
    public readonly type: string,
    public readonly stage: FXShaderStage,
  ) {
    super();
  }
  public build(ctx: FXRenderContext): void {
    ctx.setOutput("out", litVec(0, 0, 0));
  }
}

/** Reads a vec3 input and re-emits it, in a fixed stage. */
class PassVec3 extends FXRenderNode {
  public readonly inputs: readonly FXSocketDescriptor[] = [
    { key: "in", type: VEC3, required: true },
  ];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "out", type: VEC3 }];
  constructor(
    public readonly type: string,
    public readonly stage: FXShaderStage,
  ) {
    super();
  }
  public build(ctx: FXRenderContext): void {
    ctx.setOutput("out", ctx.readInput("in"));
  }
}

/** Fragment node reading a vec3 and widening it to the albedo vec4. */
class Albedo extends FXRenderNode {
  public readonly type = "albedo";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [
    { key: "in", type: VEC3, required: true },
  ];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "out", type: VEC4 }];
  public build(ctx: FXRenderContext): void {
    ctx.setOutput("out", construct(VEC4, ctx.readInput("in"), lit(1)));
  }
}

const SAMPLER = FX_VALUE_TYPES.sampler2D;

/** Emits an opaque sampler2D reference in a fixed stage. */
class SourceSampler extends FXRenderNode {
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "out", type: SAMPLER }];
  constructor(
    public readonly type: string,
    public readonly stage: FXShaderStage,
  ) {
    super();
  }
  public build(ctx: FXRenderContext): void {
    ctx.setOutput("out", ref("uniform", "u_sampler", SAMPLER));
  }
}

/** Fragment node that reads a sampler2D input and emits a constant albedo. */
class ReadSampler extends FXRenderNode {
  public readonly type = "read-sampler";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [
    { key: "in", type: SAMPLER, required: true },
  ];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "out", type: VEC4 }];
  public build(ctx: FXRenderContext): void {
    ctx.readInput("in"); // triggers the cross-stage promotion of the sampler
    ctx.setOutput("out", construct(VEC4, litVec(0, 0, 0), lit(1)));
  }
}

function graphOf(
  nodes: Record<string, FXRenderNode>,
  connections: readonly FXConnection[],
  outputBindings: readonly FXOutputBinding[],
): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({ nodes: new Map(Object.entries(nodes)), connections, outputBindings });
  return graph;
}

function edge(from: string, fromKey: string, to: string, toKey: string): FXConnection {
  return { from: { nodeId: from, socketKey: fromKey }, to: { nodeId: to, socketKey: toKey } };
}

describe("render stage-direction validation", () => {
  const compiler = new FXCompilerBaseline();

  it("rejects a fragment producer bound to a vertex output slot", () => {
    // particleTransform is a VERTEX slot (mat4); a fragment value cannot fill it.
    const frag = new SourceVec3("frag-src", FXShaderStage.FRAGMENT);
    const albedo = new SourceVec3("albedo-src", FXShaderStage.FRAGMENT);
    const graph = graphOf(
      { frag, albedo },
      [],
      [
        { slot: "particleTransform", from: { nodeId: "frag", socketKey: "out" } },
        { slot: "albedo", from: { nodeId: "albedo", socketKey: "out" } },
      ],
    );

    const result = compiler.validate(graph, FX_PARTICLE_TARGET);
    const mismatch = result.errors.find((error) => error.code === "stage-output-mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.nodeId).toBe("frag");
    expect(mismatch?.slot).toBe("particleTransform");
  });

  it("rejects a vertex consumer reading a fragment producer", () => {
    const frag = new SourceVec3("frag-src", FXShaderStage.FRAGMENT);
    const vert = new PassVec3("vert-pass", FXShaderStage.VERTEX);
    const albedo = new Albedo();
    const graph = graphOf(
      { frag, vert, albedo },
      [edge("frag", "out", "vert", "in"), edge("vert", "out", "albedo", "in")],
      [
        { slot: "particleTransform", from: { nodeId: "vert", socketKey: "out" } },
        { slot: "albedo", from: { nodeId: "albedo", socketKey: "out" } },
      ],
    );

    const result = compiler.validate(graph, FX_PARTICLE_TARGET);
    const mismatch = result.errors.find((error) => error.code === "stage-input-mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.nodeId).toBe("vert");
    expect(mismatch?.socketKey).toBe("in");
  });

  it("accepts a legitimate vertex->fragment promotion", () => {
    const vert = new SourceVec3("vert-src", FXShaderStage.VERTEX);
    const albedo = new Albedo();
    const graph = graphOf(
      { vert, albedo },
      [edge("vert", "out", "albedo", "in")],
      [{ slot: "albedo", from: { nodeId: "albedo", socketKey: "out" } }],
    );

    const result = compiler.validate(graph, FX_PARTICLE_TARGET);
    const stageCodes = ["unknown-render-stage", "stage-input-mismatch", "stage-output-mismatch"];
    expect(result.errors.some((error) => stageCodes.includes(error.code))).toBe(false);
    expect(result.ok).toBe(true);
    // The promotion is real: it compiles into a varying without throwing.
    expect(() => compiler.compile(graph, FX_PARTICLE_TARGET)).not.toThrow();
  });

  it("rejects an opaque (sampler2D) value crossing vertex->fragment", () => {
    // sampler2D is a canonical FXValueType with `instantiable: false`. The edge
    // passes type validation and the (direction-only) stage-direction check, so
    // without the guard `promote` would emit `varying sampler2D v_bridge;` - illegal
    // GLSL behind a green `recompiled`.
    const src = new SourceSampler("sampler-src", FXShaderStage.VERTEX);
    const reader = new ReadSampler();
    const graph = graphOf(
      { src, reader },
      [edge("src", "out", "reader", "in")],
      [{ slot: "albedo", from: { nodeId: "reader", socketKey: "out" } }],
    );

    // validate passes (types + direction are both fine); the defect only bites at compile.
    expect(compiler.validate(graph, FX_PARTICLE_TARGET).ok).toBe(true);
    expect(() => compiler.compile(graph, FX_PARTICLE_TARGET)).toThrow(/opaque type sampler2D/);
  });

  it("rejects a custom node whose stage is outside the enum (uniform-junk chain)", () => {
    // Both nodes share the same junk stage, so the pairwise equality checks
    // short-circuit; without the membership gate this used to reach the compile
    // pipeline and die on an internal `undefined.push`.
    const junk = "geometry" as FXShaderStage;
    const src = new SourceVec3("junk-src", junk);
    const pass = new PassVec3("junk-pass", junk);
    const graph = graphOf(
      { src, pass },
      [edge("src", "out", "pass", "in")],
      [{ slot: "albedo", from: { nodeId: "pass", socketKey: "out" } }],
    );

    const result = compiler.validate(graph, FX_PARTICLE_TARGET);
    expect(result.ok).toBe(false);
    const mismatch = result.errors.find((error) => error.code === "unknown-render-stage");
    expect(mismatch?.nodeId).toBeDefined();
    expect(mismatch?.message).toContain("unknown stage");
  });
});
