import {
  FX_TRANSFORM_FEEDBACK_INVERSE_VIEW_PROJECTION_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_FRAME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM,
  FX_TRANSFORM_FEEDBACK_VIEW_PROJECTION_UNIFORM,
} from "sparcoon";
import { describe, expect, it } from "vitest";

import { cpuSceneDepthWarnings } from "../../src/domain/sceneDepthChecks";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { compileBehaviorBundle } from "../../src/engine/behavior/FXCompiledBehaviorBundle";
import { fusedVertexSource } from "../../src/engine/behavior/FXKernelBuildStandard.Internal";
import { compileParticleBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { particleBehaviorTargetsFor } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { gpuKernelArtifactBody } from "../../src/engine/emit/artifactLiterals";
import { assembleGpuKernelArtifact } from "../../src/engine/emit/assembleArtifacts";
import { attributeSlot, storeAttr } from "../helpers/attr";
import { bind, buffersFor, edge, fieldUpdateKernel, graphOf } from "../helpers/graphBuild";
import { fullBehaviorRegistry } from "../helpers/stdRegistry";

const reg = fullBehaviorRegistry();
const VEC3 = FX_VALUE_TYPES.vec3;
const FLOAT = FX_VALUE_TYPES.float;

const DEPTH_UNIFORMS = [
  `uniform sampler2D ${FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM};`,
  `uniform mat4 ${FX_TRANSFORM_FEEDBACK_VIEW_PROJECTION_UNIFORM};`,
  `uniform mat4 ${FX_TRANSFORM_FEEDBACK_INVERSE_VIEW_PROJECTION_UNIFORM};`,
  `uniform vec3 ${FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_FRAME_UNIFORM};`,
];

/** A Depth Sample at the particle's position, storing its distance and normal. */
function sampling(): FXGraph<FXBehaviorNode> {
  return graphOf(
    {
      depth: reg.create("scene-depth-sample", {}),
      d: storeAttr("d", FLOAT),
      n: storeAttr("n", VEC3),
    },
    [edge("depth", "distance", "d", "value"), edge("depth", "normal", "n", "value")],
    [bind(attributeSlot("d"), "d", "value"), bind(attributeSlot("n"), "n", "value")],
  );
}

/** An SDF Sample with no volume in the same place - a surface sample reading no depth. */
function notSampling(): FXGraph<FXBehaviorNode> {
  return graphOf(
    {
      sdf: reg.create("sdf-sample", {}),
      d: storeAttr("d", FLOAT),
      n: storeAttr("n", VEC3),
    },
    [edge("sdf", "distance", "d", "value"), edge("sdf", "normal", "n", "value")],
    [bind(attributeSlot("d"), "d", "value"), bind(attributeSlot("n"), "n", "value")],
  );
}

describe("scene-depth-sample", () => {
  it("finds no surface in the CPU simulation", () => {
    const compiled = compileParticleBehavior(sampling());
    const buffers = buffersFor(compiled);
    buffers["position"].set([1, 2, 3]);
    fieldUpdateKernel(compiled)(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers["d"][0]).toBe(1e6);
    expect([...buffers["n"]]).toEqual([0, 1, 0]);
  });

  it("declares the depth's contract uniforms and marks the GPU kernel as reading it", () => {
    const graph = sampling();
    const program = compileBehaviorBundle(
      graph,
      particleBehaviorTargetsFor(graph, true),
    ).standardProgram;
    expect(program).toBeDefined();
    if (program === undefined) {
      return;
    }
    for (const declaration of DEPTH_UNIFORMS) {
      expect(fusedVertexSource(program).split(declaration)).toHaveLength(2);
    }
    expect(fusedVertexSource(program)).toContain(
      "vec4 fxSceneDepthContact(vec3 position, float thickness)",
    );
    expect(program.sceneDepth).toBe(true);
    expect(Object.keys(program.bindings)).not.toContain(FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM);
    expect(assembleGpuKernelArtifact(program).sceneDepth).toBe(true);
    expect(gpuKernelArtifactBody(program)).toContain("  sceneDepth: true,");
  });

  it("leaves a kernel that reads no depth without its uniforms", () => {
    const graph = notSampling();
    const program = compileBehaviorBundle(
      graph,
      particleBehaviorTargetsFor(graph, true),
    ).standardProgram;
    expect(program).toBeDefined();
    if (program === undefined) {
      return;
    }
    expect(fusedVertexSource(program)).not.toContain(FX_TRANSFORM_FEEDBACK_SCENE_DEPTH_UNIFORM);
    expect(program.sceneDepth).toBeUndefined();
    expect(assembleGpuKernelArtifact(program).sceneDepth).toBeUndefined();
    expect(gpuKernelArtifactBody(program)).not.toContain("sceneDepth");
  });

  it("warns on a reachable Depth Sample of an emitter not simulated on the GPU", () => {
    expect(cpuSceneDepthWarnings(sampling(), true)).toEqual([]);
    expect(cpuSceneDepthWarnings(notSampling(), false)).toEqual([]);
    expect(
      cpuSceneDepthWarnings(sampling(), false).map((warning) => [warning.code, warning.nodeId]),
    ).toEqual([["scene-depth-on-cpu", "depth"]]);
  });
});
