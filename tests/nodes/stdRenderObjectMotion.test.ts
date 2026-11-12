import { describe, expect, it } from "vitest";
import type { FXConnection } from "../../src/engine/core/FXGraph";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import {
  FX_MESH_TARGET,
  FX_PARTICLE_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import type { FXCompiledShader } from "../../src/engine/render/compiler/FXCompiledShader";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { renderRegistry } from "../helpers/stdRegistry";
import { drawUniformNames } from "../helpers/glslNames";

// `object-velocity` / `object-angular-velocity` are shared nodes: in render they read the
// `objectVelocity`/`objectAngularVelocity` builtins - host state FXEmitter/FXEffect push each
// tick, not a compiler-allocated uniform (same footing as `modelMatrix`, see
// stdRenderMatrix.test.ts's world-matrix test). Legal against both render targets: FXEmitter
// pushes its own object motion for particle rendering exactly as FXEffect does for a VFX mesh.

const reg = renderRegistry();
const compiler = new FXCompilerBaseline();

/** A vec3 `source` (plus `extra` nodes) -> split -> combine(vec4) -> albedo. */
function graphReadingIntoAlbedo(
  source: FXRenderNode,
  extra: Readonly<Record<string, FXRenderNode>> = {},
  connections: readonly FXConnection[] = [],
): FXGraph<FXRenderNode> {
  return graphOf(
    {
      source,
      split: reg.create("split"),
      combine: reg.create("combine", { type: "vec4" }),
      ...extra,
    },
    [
      ...connections,
      edge("source", "out", "split", "v"),
      edge("split", "x", "combine", "x"),
      edge("split", "y", "combine", "y"),
      edge("split", "z", "combine", "z"),
    ],
    [bind("albedo", "combine", "out")],
  );
}

function sourceOf(shader: FXCompiledShader): string {
  return shader.fragment.body.join("\n") + shader.vertex.body.join("\n");
}

const TARGETS = [
  ["FX_MESH_TARGET", FX_MESH_TARGET],
  ["FX_PARTICLE_TARGET", FX_PARTICLE_TARGET],
] as const;

describe("render object-velocity / object-angular-velocity nodes", () => {
  describe.each(TARGETS)("against %s", (_label, target) => {
    it.each([
      ["object-velocity", "objectVelocity"],
      ["object-angular-velocity", "objectAngularVelocity"],
    ])("%s reads the %s builtin, no compiler-allocated uniform", (type, builtin) => {
      const shader = compiler.compile(graphReadingIntoAlbedo(reg.create(type)), target);
      expect(sourceOf(shader)).toContain(builtin);
      expect(Object.keys(shader.uniforms)).toHaveLength(0);
    });
  });
});

describe("render point-velocity node", () => {
  it("compiles against FX_MESH_TARGET, combining both builtins once per tick on the CPU", () => {
    const shader = compiler.compile(
      graphReadingIntoAlbedo(reg.create("point-velocity", { offset: [0, 1, 0] })),
      FX_MESH_TARGET,
    );
    // v + w x r reads the object's motion alone, so the draw stage computes it (an offset: at
    // none, w x r folds away).
    const compute = shader.draw?.statements.join("\n") ?? "";
    expect(compute).toContain("inputs.objectVelocity[");
    expect(compute).toContain("inputs.objectAngularVelocity[");
    expect(drawUniformNames(shader)).toContain(shader.outputs["albedo"]);
  });

  it("compiles against FX_PARTICLE_TARGET too, even with velocity/torque fully wired explicitly", () => {
    // Legality is derived from the node's declared socket defaults (its schema), not from
    // whether a given instance actually connects them - so wiring both away from their
    // objectVelocity/objectAngularVelocity defaults does not change the outcome.
    const graph = graphReadingIntoAlbedo(
      reg.create("point-velocity", { offset: [0, 1, 0] }),
      {
        velocity: reg.create("constant", { type: "vec3", value: [1, 0, 0] }),
        torque: reg.create("constant", { type: "vec3", value: [0, 0, 1] }),
      },
      [edge("velocity", "out", "source", "velocity"), edge("torque", "out", "source", "torque")],
    );
    expect(sourceOf(compiler.compile(graph, FX_PARTICLE_TARGET))).toContain("cross(");
  });
});
