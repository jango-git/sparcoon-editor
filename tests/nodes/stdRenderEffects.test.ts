import { describe, expect, it } from "vitest";

import { collectRenderCapabilities } from "../../src/engine/core/compiler/collectRenderCapabilities";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import {
  fxAmbientShading,
  fxHalfLitShading,
  fxLambertShading,
} from "../../src/engine/nodes-std/render/lighting";
import type { FXCompiledShader } from "../../src/engine/render/compiler/FXCompiledShader";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { renderRegistry } from "../helpers/stdRegistry";

const reg = renderRegistry();
const compiler = new FXCompilerBaseline();

/** Compiles a particle-target render graph on the baseline compiler. */
function compile(
  nodes: Readonly<Record<string, FXRenderNode>>,
  connections: readonly FXConnection[],
  outputBindings: readonly FXOutputBinding[],
): FXCompiledShader {
  return compiler.compile(graphOf(nodes, connections, outputBindings), FX_PARTICLE_TARGET);
}

/** The fragment body of a shading graph: optional `normal` source -> lit -> albedo. */
function shadedBody(
  type: string,
  extra: Readonly<Record<string, FXRenderNode>> = {},
  connections: readonly FXConnection[] = [],
): string {
  const shader = compile({ lit: reg.create(type), ...extra }, connections, [
    bind("albedo", "lit", "color"),
  ]);
  return shader.fragment.body.join("\n");
}

describe("standard render effects", () => {
  it("color -> dissolve -> albedo emits the shared noise helper and samples it", () => {
    const shader = compile(
      {
        c: reg.create("constant", { type: "color" }),
        d: reg.create("dissolve", { scale: 6, edge: 0.2 }),
      },
      [edge("c", "out", "d", "color")],
      [bind("albedo", "d", "color")],
    );
    const helpers = shader.fragment.helperFunctions.join("\n");
    const body = shader.fragment.body.join("\n");
    // dissolve builds on the shared `noise` primitive through ordinary IR calls, so only that
    // helper shows up, with its own smoothstep call site inline in the body.
    expect(helpers).toContain("float noise(vec2 p)");
    expect(body).toContain("noise(");
    expect(body).toContain("smoothstep(");
    // color + dissolve's scale/edge are all inline literals - no uniform slots spent.
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
  });

  it("blend composites two colors", () => {
    expect(() =>
      compile(
        {
          a: reg.create("constant", { type: "color", value: [1, 0, 0, 1] }),
          b: reg.create("constant", { type: "color", value: [0, 0, 1, 1] }),
          mix: reg.create("blend", { mode: "add" }),
        },
        [edge("a", "out", "mix", "base"), edge("b", "out", "mix", "blend")],
        [bind("albedo", "mix", "color")],
      ),
    ).not.toThrow();
  });

  it("lightness-blending-mask scales the color by a guarded brightness smoothstep", () => {
    const shader = compile(
      {
        c: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        m: reg.create("lightness-blending-mask", { edge0: 0.4, edge1: 0.4 }),
      },
      [edge("c", "out", "m", "color")],
      [bind("albedo", "m", "color")],
    );
    const helpers = shader.fragment.helperFunctions.join("\n");
    // The mask is a smoothstep over brightness whose upper edge is kept above the lower one, so
    // equal edges are a hard threshold rather than an undefined smoothstep.
    expect(helpers).toContain("smoothstep(edge0, max(edge1, edge0");
    // The inline edges reach the call that multiplies the color.
    expect(shader.fragment.body.join("\n")).toMatch(
      /\* fxLightnessBlendingMask\([^)]*0\.4, 0\.4\)/,
    );
  });
});

describe("standard render lighting and normals", () => {
  it("normal-map unpacks a sampled color and rotates it to world via the surface frame", () => {
    const body = shadedBody(
      "lambert-shading",
      {
        map: reg.create("constant", { type: "vec4", value: [0.5, 0.5, 1, 1] }),
        nm: reg.create("normal-map"),
      },
      [edge("map", "out", "nm", "color"), edge("nm", "normal", "lit", "normal")],
    );
    // The unpacked tangent normal goes through the shared surface frame (world), then to the
    // lighting intrinsic.
    expect(body).toContain("fxUnpackNormal");
    expect(body).toContain("fxTangentToWorldNormal");
    expect(body).toContain("fxLambertShade");
  });

  it("surface-normal reads the world-space geometryNormal builtin", () => {
    const body = shadedBody("lambert-shading", { sn: reg.create("surface-normal") }, [
      edge("sn", "normal", "lit", "normal"),
    ]);
    expect(body).toContain("geometryNormal");
  });

  it("spherical-normal is authored in tangent space and rotated through the surface frame", () => {
    const body = shadedBody("lambert-shading", { sn: reg.create("spherical-normal") }, [
      edge("sn", "normal", "lit", "normal"),
    ]);
    expect(body).toContain("fxComputeSphericalNormal");
    expect(body).toContain("fxTangentToWorldNormal");
    expect(body).toContain("geometryTangent");
  });

  it.each([fxLambertShading, fxHalfLitShading, fxAmbientShading])(
    "$type exposes inline Color + Emission color pickers",
    (def) => {
      const inputs = def.describe().inputs;
      expect(inputs.find((socket) => socket.key === "color")?.control?.color).toBe(true);
      expect(inputs.find((socket) => socket.key === "emission")?.control?.color).toBe(true);
    },
  );

  it.each([
    ["lambert-shading", "fxLambertShade"],
    ["half-lit-shading", "fxHalfLitShade"],
    ["ambient-shading", "fxAmbientShade"],
  ])(
    "%s shades the geometry normal when none is wired and adds its emission",
    (type, intrinsic) => {
      const body = shadedBody(
        type,
        { emit: reg.create("constant", { type: "vec4", value: [0.2, 0, 0, 1] }) },
        [edge("emit", "out", "lit", "emission")],
      );
      expect(body).toContain(`${intrinsic}(`);
      expect(body).toContain("geometryNormal");
      // The emission rgb is added on top of the shaded color.
      expect(body).toContain("0.2");
    },
  );

  it("half-lit-shading passes wrap, scatter and focus after the normal, in that order", () => {
    const body = shadedBody(
      "half-lit-shading",
      { scatter: reg.create("constant", { type: "float", value: 2.5 }) },
      [edge("scatter", "out", "lit", "scatter")],
    );
    expect(body).toMatch(/fxHalfLitShade\([^;]*geometryNormal, 1\.0, [^,;]+, 8\.0\)/);
    expect(body).toContain("2.5");
  });

  it("half-lit-shading asks the runtime for its intrinsic only", () => {
    const graph = graphOf(
      { lit: reg.create("half-lit-shading") },
      [],
      [bind("albedo", "lit", "color")],
    );
    expect(collectRenderCapabilities(graph).lightingIntrinsics).toEqual(["fxHalfLitShade"]);
  });
});
