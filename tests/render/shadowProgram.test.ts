import { FXMeshMaterial } from "sparcoon/editor";
import type { ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";

import { assembleRenderArtifact } from "../../src/engine/emit/assembleArtifacts";
import type { FXCompiledProgram } from "../../src/engine/render/compiler/FXCompiledShader";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FXCompilerStandard } from "../../src/engine/render/compiler/FXCompilerStandard";
import {
  FX_MESH_TARGET,
  FX_PARTICLE_TARGET,
  FX_TRAIL_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { fullRenderRegistry } from "../helpers/stdRegistry";

const reg = fullRenderRegistry();
const COMPILERS = [
  ["baseline", new FXCompilerBaseline()],
  ["standard", new FXCompilerStandard()],
] as const;

/** Every line of `program`'s code: helpers, bodies and outputs. */
function code(program: FXCompiledProgram | undefined): string {
  if (program === undefined) {
    throw new Error("no program");
  }
  return [
    ...program.vertex.helperFunctions,
    ...program.vertex.body,
    ...program.fragment.helperFunctions,
    ...program.fragment.body,
    ...Object.values(program.outputs),
  ].join("\n");
}

/** A lit particle: a texture-free color shaded by Lambert, its alpha faded over the life. */
function litGraph() {
  return graphOf(
    {
      col: reg.create("constant", { type: "color", value: [1, 0.5, 0.25, 1] }),
      life: reg.create("life-ratio"),
      fade: reg.create("binary-op", { op: "multiply" }),
      lit: reg.create("lambert-shading"),
    },
    [
      edge("col", "out", "fade", "a"),
      edge("life", "out", "fade", "b"),
      edge("fade", "out", "lit", "color"),
    ],
    [bind("albedo", "lit", "color")],
  );
}

/** A lit VFX mesh: a constant color shaded by Lambert. */
function litMeshGraph() {
  return graphOf(
    {
      col: reg.create("constant", { type: "color", value: [1, 0.5, 0.25, 0.5] }),
      lit: reg.create("lambert-shading"),
    },
    [edge("col", "out", "lit", "color")],
    [bind("albedo", "lit", "color")],
  );
}

describe.each(COMPILERS)("the shadow program (%s)", (_tier, compiler) => {
  it("computes the albedo's alpha and none of the lighting feeding only the color", () => {
    const shader = compiler.compile(litGraph(), FX_PARTICLE_TARGET);
    expect(code(shader.color)).toContain("fxLambertShade");
    const shadow = code(shader.shadow);
    expect(shadow).not.toContain("fxLambertShade");
    expect(shadow).not.toContain("geometryNormal");
    expect(shader.shadow?.fragment.targetReads).not.toContain("geometryNormal");
    expect(Object.keys(shader.shadow?.outputs ?? {})).toEqual(["alpha"]);
    // The alpha still fades over the life, as the color program's does.
    expect(shadow).toContain("PARTICLE_AGE");
  });

  it("gives a wired shadowThreshold to the shadow program alone", () => {
    const graph = graphOf(
      {
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 0.5] }),
        life: reg.create("life-ratio"),
      },
      [],
      [bind("albedo", "col", "out"), bind("shadowThreshold", "life", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.color.outputs["shadowThreshold"]).toBeUndefined();
    expect(shader.shadow?.outputs["shadowThreshold"]).toBeDefined();
    expect(code(shader.color)).not.toContain("PARTICLE_AGE");
    expect(code(shader.shadow)).toContain("PARTICLE_AGE");
  });

  it("leaves alphaThreshold out of the shadow program when its own threshold is wired", () => {
    const graph = graphOf(
      {
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 0.5] }),
        life: reg.create("life-ratio"),
        half: reg.create("constant", { type: "float", value: 0.5 }),
      },
      [],
      [
        bind("albedo", "col", "out"),
        bind("alphaThreshold", "life", "out"),
        bind("shadowThreshold", "half", "out"),
      ],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(Object.keys(shader.shadow?.outputs ?? {}).sort()).toEqual(["alpha", "shadowThreshold"]);
    // The life ratio fed only the cutoff the runtime would not read.
    expect(code(shader.shadow)).not.toContain("PARTICLE_AGE");
    expect(code(shader.color)).toContain("PARTICLE_AGE");
  });

  it("carries the cutoff and the transforms over from the color program", () => {
    const graph = graphOf(
      {
        col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        life: reg.create("life-ratio"),
        look: reg.create("look-at-camera"),
        to4: reg.create("compose-transform"),
      },
      [edge("look", "out", "to4", "rotation")],
      [
        bind("albedo", "col", "out"),
        bind("alphaThreshold", "life", "out"),
        bind("particleTransform", "to4", "out"),
      ],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(Object.keys(shader.shadow?.outputs ?? {}).sort()).toEqual([
      "alpha",
      "alphaThreshold",
      "particleTransform",
    ]);
  });

  it("reads an albedo lifted to the draw stage off its uniform, lifting nothing twice", () => {
    const graph = graphOf(
      {
        col: reg.create("constant", { type: "color", value: [1, 0.5, 0.25, 1] }),
        time: reg.create("time"),
        pulse: reg.create("binary-op", { op: "multiply" }),
      },
      [edge("col", "out", "pulse", "a"), edge("time", "out", "pulse", "b")],
      [bind("albedo", "pulse", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const albedo = shader.color.outputs["albedo"] ?? "";
    expect(Object.keys(shader.uniforms)).toEqual([albedo]);
    expect(code(shader.shadow)).toContain(`(${albedo}).w`);
  });

  it("has no particle transform on a VFX mesh", () => {
    const shader = compiler.compile(litMeshGraph(), FX_MESH_TARGET);
    expect(code(shader.color)).toContain("fxLambertShade");
    expect(code(shader.shadow)).not.toContain("fxLambertShade");
    expect(Object.keys(shader.shadow?.outputs ?? {})).toEqual(["alpha"]);
  });

  it("is absent for a trail, which casts no shadow", () => {
    const graph = graphOf(
      { col: reg.create("constant", { type: "color", value: [1, 1, 1, 1] }) },
      [],
      [bind("albedo", "col", "out")],
    );
    expect(compiler.compile(graph, FX_TRAIL_TARGET).shadow).toBeUndefined();
  });
});

describe("the shadow program, drawn by the runtime", () => {
  it("casts from the alpha alone: the depth material's main calls no lighting", () => {
    const shader = new FXCompilerStandard().compile(litMeshGraph(), FX_MESH_TARGET);
    const render = assembleRenderArtifact(
      shader,
      { type: "primitive", primitive: "plane" },
      [],
      "alphaTest",
    );
    const depth = new FXMeshMaterial(render).buildThreeDepthMaterial() as ShaderMaterial;
    const main = depth.fragmentShader.slice(depth.fragmentShader.indexOf("void main()"));
    expect(main).toContain("float fxShadowAlpha = ");
    expect(main).toContain("discard;");
    expect(main).not.toContain("fxLambertShade(");
  });
});
