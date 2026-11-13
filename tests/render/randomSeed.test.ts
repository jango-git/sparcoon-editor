import type { FXRenderArtifact, FXValueSlot } from "sparcoon";
import { describe, expect, it } from "vitest";

import { isMeshExcludedRenderNode, NODE_PALETTE } from "../../src/domain/nodePalette";
import { compileParticleBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { buildDrawCompute } from "../../src/engine/core/codegen/drawStageBuild.Internal";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_RANDOM_SEED_INPUT } from "../../src/engine/core/socket/FXReadableBuiltins";
import { assembleRenderArtifact } from "../../src/engine/emit/assembleArtifacts";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FXCompilerStandard } from "../../src/engine/render/compiler/FXCompilerStandard";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import {
  FX_MESH_TARGET,
  FX_PARTICLE_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry, fullRenderRegistry } from "../helpers/stdRegistry";

const render = fullRenderRegistry();
const compiler = new FXCompilerBaseline();

/** An albedo of `hash` seeded by default, and a uv-varied hash, so the seed stays on the GPU. */
function hashedAlbedo(): FXGraph<FXRenderNode> {
  return graphOf<FXRenderNode>(
    {
      h: render.create("hash", { type: "vec4" }),
      uv: render.create("uv"),
      s: render.create("split", { type: "vec2" }),
      v: render.create("hash", { type: "float" }),
    },
    [edge("uv", "uv", "s", "v"), edge("s", "x", "v", "salt")],
    [bind("albedo", "h", "out"), bind("intensity", "v", "out")],
  );
}

describe("Hash's default seed", () => {
  it("is offered on a VFX mesh: every target has a seed", () => {
    const hash = NODE_PALETTE.find((meta) => meta.type === "hash");
    expect(hash).toBeDefined();
    expect(isMeshExcludedRenderNode(hash!)).toBe(false);
    expect(FX_MESH_TARGET.inputs.find((input) => input.name === FX_RANDOM_SEED_INPUT)?.rate).toBe(
      "frame",
    );
  });

  it("reads the mesh's own seed on a VFX mesh, and the particle's id on a particle", () => {
    const mesh = compiler.compile(hashedAlbedo(), FX_MESH_TARGET);
    expect(JSON.stringify(mesh)).toContain(FX_RANDOM_SEED_INPUT);
    const particle = compiler.compile(hashedAlbedo(), FX_PARTICLE_TARGET);
    // RANDOM_SEED is PARTICLE_ID on a particle: reading it needs the particle's lifecycle.
    const artifact = assembleRenderArtifact(
      particle,
      { type: "primitive", primitive: "plane" },
      [],
      "blending",
    );
    expect(
      artifact.color.vertex.particleReads.lifecycle ||
        artifact.color.fragment.particleReads.lifecycle,
    ).toBe(true);
  });

  it("seeds a behavior's hash by the particle's id", () => {
    const behavior = behaviorRegistry();
    const graph = graphOf(
      { h: behavior.create("hash", { type: "float", phase: "spawn" }) },
      [],
      [bind("positionX", "h", "out", "spawn")],
    );
    expect(() => compileParticleBehavior(graph)).not.toThrow();
    // Two particles of ids 0 and 1 (the host numbers them): two different draws.
    const first = runKernel(graph, {
      phase: "spawn",
      count: 2,
      state: { lifecycle: [0, 0, 0, 0, 0, 1] },
    });
    expect(first["position"][0]).not.toBe(first["position"][3]);
  });

  it("draws once per tick on the CPU from the mesh's seed: another seed, another value", () => {
    const shader = new FXCompilerStandard().compile(
      graphOf(
        {
          h: render.create("hash", { type: "float" }),
          col: render.create("constant", { type: "color", value: [1, 1, 1, 1] }),
        },
        [],
        [bind("intensity", "h", "out"), bind("albedo", "col", "out")],
      ),
      FX_MESH_TARGET,
    );
    const stage = shader.draw;
    expect(stage).toBeDefined();
    const compute = buildDrawCompute<NonNullable<FXRenderArtifact["compute"]>>(stage!);
    const valueFor = (seed: number): unknown[] => {
      const uniforms: Record<string, FXValueSlot<number | number[]>> = {};
      for (const [name, handle] of Object.entries(shader.uniforms)) {
        uniforms[name] = { value: handle.value as number };
      }
      compute(
        {
          time: 0,
          deltaTime: 0,
          modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          objectVelocity: [0, 0, 0],
          objectAngularVelocity: [0, 0, 0],
          seed,
        },
        uniforms,
      );
      return Object.values(uniforms).map((slot) => slot.value);
    };
    expect(valueFor(0)).toEqual(valueFor(0));
    expect(valueFor(0)).not.toEqual(valueFor(1));
  });
});
