import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXSocketDescriptor } from "../../src/engine/core/socket/FXSocket";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import {
  add,
  div,
  lit,
  litInt,
  litVec,
  mul,
  swizzle,
  toFloat,
  toInt,
} from "../../src/engine/core/ir/FXExprBuilder";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FXCompilerStandard } from "../../src/engine/render/compiler/FXCompilerStandard";
import type { FXRenderContext } from "../../src/engine/render/compiler/FXRenderContext";
import { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { renderRegistry } from "../helpers/stdRegistry";

/**
 * Pilot proving the two-compiler mechanism end to end on real (not fake) nodes - proves out the
 * baselineBuild mechanism on a couple of real node upgrades before it applies project-wide. Not
 * registered into the standard node library - these are compiler-plumbing fixtures, not a shipped
 * palette feature.
 */

const reg = renderRegistry();
const FLOAT = FX_VALUE_TYPES.float;
const VEC2 = FX_VALUE_TYPES.vec2;
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

/** Fixed white albedo, so a graph only needs to wire up the real fixture under test. */
class AlbedoStub extends FXRenderNode {
  public readonly type = "test-albedo-stub";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "color", type: VEC4 }];
  public build(ctx: FXRenderContext): void {
    ctx.setOutput("color", litVec(1, 1, 1, 1));
  }
}

/**
 * Real (not fake) pilot node: the primary `build` is a genuine WebGL2-only integer hash (Ken
 * Perlin's classic `IntNoise`, needing bitwise int ops GLSL ES 1.00 has no operators for);
 * `baselineBuild` is a classic sin-based float hash ("fractal-cosine" noise), valid GLSL ES 1.00.
 */
class HashNoiseNode extends FXRenderNode {
  public readonly type = "test-hash-noise";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [
    { key: "p", type: VEC2, required: true },
  ];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "out", type: FLOAT }];

  public build(ctx: FXRenderContext): void {
    const p = ctx.readInput("p");
    const cellX = toInt(ctx.builders.call("floor", swizzle(p, "x")));
    const cellY = toInt(ctx.builders.call("floor", swizzle(p, "y")));
    const combined = add(cellX, mul(cellY, litInt(57)));
    const shifted = ctx.builders.call("intShiftLeft", combined, litInt(13));
    const mixed = ctx.builders.call("intXor", shifted, combined);
    const squared = mul(mixed, mixed);
    const step1 = add(mul(squared, litInt(15731)), mul(mixed, litInt(789221)));
    const step2 = add(mul(step1, step1), litInt(1376312589));
    const masked = ctx.builders.call("intAnd", step2, litInt(0x00ffffff));
    ctx.setOutput("out", div(toFloat(masked), lit(16777216)));
  }

  public baselineBuild(ctx: FXRenderContext): void {
    const p = ctx.readInput("p");
    const dotValue = ctx.builders.call("dot", p, litVec(12.9898, 78.233));
    const sinValue = ctx.builders.call("sin", dotValue);
    ctx.setOutput("out", ctx.builders.call("fract", mul(sinValue, lit(43758.5453))));
  }
}

/** Same standard-only capability, deliberately with NO baselineBuild - proves the enforcement path. */
class StandardOnlyNoFallbackNode extends FXRenderNode {
  public readonly type = "test-standard-only-no-fallback";
  public readonly stage = FXShaderStage.FRAGMENT;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [{ key: "out", type: FLOAT }];
  public build(ctx: FXRenderContext): void {
    ctx.setOutput("out", toFloat(ctx.builders.call("intXor", litInt(1), litInt(2))));
  }
}

function withHashNoise(): FXGraph<FXRenderNode> {
  const uv = reg.create("uv", {});
  const noise = new HashNoiseNode();
  const albedo = new AlbedoStub();
  return graphOf(
    { uv, noise, albedo },
    [edge("uv", "uv", "noise", "p")],
    [
      { slot: "albedo", from: { nodeId: "albedo", socketKey: "color" } },
      { slot: "alphaThreshold", from: { nodeId: "noise", socketKey: "out" } },
    ],
  );
}

describe("baselineBuild mechanism (pilot)", () => {
  it("baseline (FXCompilerBaseline) uses the fractal-cosine fallback, not the int hash", () => {
    const shader = new FXCompilerBaseline().compile(withHashNoise(), FX_PARTICLE_TARGET);
    const body = shader.fragment.body.join("\n");
    expect(body).toContain("sin(");
    expect(body).not.toMatch(/[&^]|<</);
  });

  it("WebGL2 (FXCompilerStandard) uses the primary int-hash build, never baselineBuild", () => {
    const shader = new FXCompilerStandard().compile(withHashNoise(), FX_PARTICLE_TARGET);
    const body = shader.fragment.body.join("\n");
    expect(body).toMatch(/[&^]|<</);
    expect(body).not.toContain("sin(");
  });

  it("a standardOnly function with no baselineBuild throws under the baseline compiler", () => {
    const graph = graphOf(
      { standardOnly: new StandardOnlyNoFallbackNode(), albedo: new AlbedoStub() },
      [],
      [
        { slot: "albedo", from: { nodeId: "albedo", socketKey: "color" } },
        { slot: "alphaThreshold", from: { nodeId: "standardOnly", socketKey: "out" } },
      ],
    );
    expect(() => new FXCompilerBaseline().compile(graph, FX_PARTICLE_TARGET)).toThrow(
      /unknown function/,
    );
  });

  it("...but compiles fine under FXCompilerStandard", () => {
    const graph = graphOf(
      { standardOnly: new StandardOnlyNoFallbackNode(), albedo: new AlbedoStub() },
      [],
      [
        { slot: "albedo", from: { nodeId: "albedo", socketKey: "color" } },
        { slot: "alphaThreshold", from: { nodeId: "standardOnly", socketKey: "out" } },
      ],
    );
    const shader = new FXCompilerStandard().compile(graph, FX_PARTICLE_TARGET);
    expect(shader.fragment.body.join("\n")).toContain("^");
  });
});
