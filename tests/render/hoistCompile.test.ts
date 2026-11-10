import { describe, expect, it } from "vitest";
import { fxGraphVaryingAllowance, packedVaryingVectors, fxVaryingShape } from "sparcoon/editor";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import type { FXCompiledShader } from "../../src/engine/render/compiler/FXCompiledShader";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FXCompilerStandard } from "../../src/engine/render/compiler/FXCompilerStandard";
import {
  FX_MESH_TARGET,
  FX_PARTICLE_TARGET,
  FX_TRAIL_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { fullRenderRegistry } from "../helpers/stdRegistry";

/**
 * The compiler computes a fragment-stage value that is the same at every fragment of a particle
 * once per vertex instead, carrying the result across - as far as the tier's varyings allow.
 */

const reg = fullRenderRegistry();
const standard = new FXCompilerStandard();
const baseline = new FXCompilerBaseline();

const vertexOf = (shader: FXCompiledShader): string => shader.vertex.body.join("\n");
const fragmentOf = (shader: FXCompiledShader): string => shader.fragment.body.join("\n");

/** Alpha = a curve over `source` (life ratio by default) times the uv's length; white rgb. */
function fadeGraph(source: "life-ratio" | "time" = "life-ratio"): FXGraph<FXRenderNode> {
  return graphOf(
    {
      clock: reg.create(source),
      curve: reg.create("ramp"),
      uv: reg.create("uv"),
      radius: reg.create("length"),
      alpha: reg.create("binary-op", { op: "multiply" }),
      color: reg.create("combine-color"),
    },
    [
      edge("clock", "out", "curve", "t"),
      edge("uv", "uv", "radius", "v"),
      edge("curve", "out", "alpha", "a"),
      edge("radius", "out", "alpha", "b"),
      edge("alpha", "out", "color", "alpha"),
    ],
    [bind("albedo", "color", "color")],
  );
}

describe("per-vertex hoist of per-particle fragment values", () => {
  it("computes a curve over the life ratio per vertex, carried flat on Standard", () => {
    const shader = standard.compile(fadeGraph(), FX_PARTICLE_TARGET);
    expect(vertexOf(shader)).toMatch(/float curveValue_\d+ = /);
    expect(vertexOf(shader)).toContain("PARTICLE_AGE");
    // The fragment reads the curve's value, not the particle's age, and still does the uv part.
    expect(fragmentOf(shader)).not.toContain("PARTICLE_AGE");
    expect(fragmentOf(shader)).not.toMatch(/curveValue_\d+ = /);
    expect(fragmentOf(shader)).toContain("length(");
    expect(shader.fragment.targetReads).not.toContain("PARTICLE_AGE");
    expect(shader.varyings.map((varying) => varying.interpolation)).toEqual(["flat"]);
  });

  it("marks it flat on Baseline too: the runtime qualifies it where the GLSL can", () => {
    const shader = baseline.compile(fadeGraph(), FX_PARTICLE_TARGET);
    expect(vertexOf(shader)).toMatch(/float curveValue_\d+ = /);
    expect(shader.varyings.map((varying) => varying.interpolation)).toEqual(["flat"]);
  });

  it("keeps a trail's per-point values in the fragment: they change along the ribbon", () => {
    const shader = standard.compile(fadeGraph(), FX_TRAIL_TARGET);
    expect(fragmentOf(shader)).toMatch(/float curveValue_\d+ = /);
    expect(fragmentOf(shader)).toContain("PARTICLE_AGE");
    expect(shader.varyings).toEqual([]);
  });

  it("computes a mesh's clock-driven value per vertex", () => {
    const shader = standard.compile(fadeGraph("time"), FX_MESH_TARGET);
    expect(vertexOf(shader)).toMatch(/float curveValue_\d+ = /);
    expect(vertexOf(shader)).toContain("u_time");
    expect(fragmentOf(shader)).not.toContain("u_time");
  });

  it("moves a flipbook's frame with its helper, and keeps the texture fetch per fragment", () => {
    const graph = graphOf(
      {
        life: reg.create("life-ratio"),
        sheet: reg.create("animated-texture", { columns: 4, rows: 4 }),
        sprite: reg.create("texture", { name: "sheet" }),
      },
      [edge("life", "out", "sheet", "lifetimeRatio"), edge("sheet", "uvFrame", "sprite", "uv")],
      [bind("albedo", "sprite", "color")],
    );
    const shader = standard.compile(graph, FX_PARTICLE_TARGET);
    expect(vertexOf(shader)).toContain("fxAnimatedFrameOnce(");
    expect(shader.vertex.helperFunctions.join("\n")).toContain("vec3 fxAnimatedFrameOnce(");
    expect(fragmentOf(shader)).toContain("fxSample_u_param_sheet(");
    expect(fragmentOf(shader)).toContain("fxFlipbookFrameUV(");
    expect(fragmentOf(shader)).not.toContain("fxAnimatedFrameOnce(");
  });

  it("never carries more than the tier leaves a graph", () => {
    // Eight per-particle colors, each modulated per fragment: carrying all of them would take
    // eight vec4 rows, past Baseline's allowance, so the cheapest stay per fragment.
    const nodes: Record<string, FXRenderNode> = {
      life: reg.create("life-ratio"),
      uv: reg.create("uv"),
      radius: reg.create("length"),
    };
    const edges = [edge("uv", "uv", "radius", "v")];
    let previous = "";
    for (let index = 0; index < 8; index++) {
      nodes[`ramp${String(index)}`] = reg.create("color-ramp");
      nodes[`mod${String(index)}`] = reg.create("binary-op", { op: "multiply" });
      edges.push(
        edge("life", "out", `ramp${String(index)}`, "t"),
        edge(`ramp${String(index)}`, "color", `mod${String(index)}`, "a"),
        edge("radius", "out", `mod${String(index)}`, "b"),
      );
      if (previous !== "") {
        nodes[`sum${String(index)}`] = reg.create("binary-op", { op: "add" });
        edges.push(
          edge(previous, "out", `sum${String(index)}`, "a"),
          edge(`mod${String(index)}`, "out", `sum${String(index)}`, "b"),
        );
        previous = `sum${String(index)}`;
      } else {
        previous = `mod${String(index)}`;
      }
    }
    const graph = graphOf(nodes, edges, [bind("albedo", previous, "out")]);
    const none = { normal: false, tangent: false, position: false };
    for (const [compiler, tier] of [
      [baseline, "baseline"],
      [standard, "standard"],
    ] as const) {
      const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
      const rows = packedVaryingVectors(
        shader.varyings.map((varying) => fxVaryingShape(varying.type.glslTypeName)),
      );
      expect(rows).toBeLessThanOrEqual(fxGraphVaryingAllowance(tier, none));
      expect(shader.varyings.length).toBeGreaterThan(0);
    }
  });
});
