import type {
  FXAttributeDecl,
  FXBehaviorArtifact,
  FXGeometrySource,
  FXParticleKernelArtifact,
  FXRenderArtifact,
  FXRenderMode,
  FXRenderProgram,
  FXUniformInit,
  FXValueSlot,
} from "sparcoon";
import type { Texture } from "three";

import type { FXCompiledKernel, FXCompiledKernelPhase } from "../behavior/FXCompiledKernel";
import {
  fusedVertexSource,
  type FXFusedProgramStandard,
} from "../behavior/FXKernelBuildStandard.Internal";
import { kernelResourceFields, resourceFieldsOf } from "../behavior/FXKernelShared.Internal";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
} from "../behavior/FXParticleBehaviorKernel.Internal";
import { buildDrawCompute } from "../core/codegen/drawStageBuild.Internal";
import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import type { FXCompiledProgram, FXCompiledShader } from "../render/compiler/FXCompiledShader";
import { zeroValue } from "../render/compiler/FXCompiledShader";
import { fragmentStageSource, stageSource, varyingDecls } from "./artifactLiterals";

/**
 * Assembles the runtime artifacts in memory from the compiler IR. Value slots snapshot the current
 * handle values and are not shared with the editor, so edits arrive through `FXEmitter.applyValues`.
 */

function attributeDecls(attributes: readonly FXAttributeRequest[]): FXAttributeDecl[] {
  return attributes.map((attribute) => ({
    name: attribute.name,
    components: attribute.type.components as 1 | 2 | 3 | 4,
  }));
}

/** A non-external uniform's serialized form: a number/vector value keeps the parsed `type`; a
 *  non-numeric value is a generated texture, so force `type: "sampler2D"` rather than trusting
 *  a mis-declared `FXValueType`. */
function toUniformInit(value: unknown, type: string): FXUniformInit {
  if (typeof value === "number") {
    return { type, value };
  }
  if (Array.isArray(value) && value.every((component) => typeof component === "number")) {
    return { type, value: value };
  }
  return { type: "sampler2D", value: value as Texture };
}

function renderProgram(program: FXCompiledProgram): FXRenderProgram {
  return {
    varyings: varyingDecls(program),
    vertex: stageSource(program.vertex),
    fragment: fragmentStageSource(program.fragment),
    outputs: { ...program.outputs },
  };
}

export function assembleRenderArtifact(
  shader: FXCompiledShader,
  geometry: FXGeometrySource,
  attributes: readonly FXAttributeRequest[],
  renderMode: FXRenderMode,
): FXRenderArtifact {
  const uniforms: Record<string, FXUniformInit> = {};
  for (const [name, handle] of Object.entries(shader.uniforms)) {
    if (handle.external !== undefined) {
      uniforms[name] = { type: "sampler2D", external: handle.external };
      continue;
    }
    // A fresh slot snapshotting the handle's current value (number/vector/texture): the editor
    // handle is not shared, and each runtime instance seeds its own slot from this one.
    uniforms[name] = toUniformInit(handle.value, handle.type.glslTypeName);
  }
  return {
    lightingIntrinsics: shader.capabilities.lightingIntrinsics,
    sceneDepth: shader.capabilities.sceneDepth,
    geometry,
    options: { renderMode },
    color: renderProgram(shader.color),
    ...(shader.shadow === undefined ? {} : { shadow: renderProgram(shader.shadow) }),
    uniforms,
    attributeReads: attributeDecls(attributes),
    ...(shader.draw === undefined
      ? {}
      : { compute: buildDrawCompute<NonNullable<FXRenderArtifact["compute"]>>(shader.draw) }),
  };
}

/**
 * The `bindings` record both phases share. A same-named binding with different values across phases
 * is rejected.
 */
function mergeBindingSlots(
  kernel: FXCompiledKernel,
): Record<string, FXValueSlot<number | Float32Array>> {
  const merged: Record<string, FXValueSlot<number | Float32Array>> = {};
  const collect = (phase: FXCompiledKernelPhase | undefined): void => {
    if (phase === undefined) {
      return;
    }
    for (const [name, handle] of Object.entries(phase.bindings)) {
      const existing = merged[name];
      if (existing !== undefined && existing.value !== handle.value) {
        throw new Error(
          `assembleBehaviorArtifact: binding "${name}" has conflicting values across the spawn and update phases`,
        );
      }
      merged[name] = { value: handle.value };
    }
  };
  collect(kernel.spawn);
  collect(kernel.update);
  return merged;
}

export function assembleBehaviorArtifact(kernel: FXCompiledKernel): FXBehaviorArtifact {
  const base: FXBehaviorArtifact = {
    // The slot, in the target's order (see `buildParticleBehaviorTargets`).
    buffers: kernel.update.buffers.map((buffer) => ({ name: buffer.name, stride: buffer.stride })),
    bindings: mergeBindingSlots(kernel),
    ...kernelResourceFields(kernel),
    ...(kernel.inherit === undefined
      ? {}
      : {
          inherit: {
            stride: kernel.inherit.layout.stride,
            defaults: [...kernel.inherit.layout.defaults],
          },
        }),
    update: buildParticleUpdateKernel(kernel),
  };
  return kernel.spawn === undefined ? base : { ...base, spawn: buildParticleSpawnKernel(kernel) };
}

export function assembleGpuKernelArtifact(
  program: FXFusedProgramStandard,
): FXParticleKernelArtifact {
  const bindings: FXParticleKernelArtifact["bindings"] = {};
  for (const [name, handle] of Object.entries(program.bindings)) {
    bindings[name] = { value: handle.value };
  }
  for (const [name, type] of Object.entries(program.draw?.uniforms ?? {})) {
    bindings[name] = { value: zeroValue(type) };
  }
  return {
    vertexSource: fusedVertexSource(program),
    fragmentSource: program.fragmentSource,
    buffers: program.buffers.map((buffer) => ({ name: buffer.name, stride: buffer.stride })),
    transformFeedbackVaryings: [...program.transformFeedbackVaryings],
    bindings,
    ...resourceFieldsOf(program),
    ...(program.sceneDepth === true ? { sceneDepth: true } : {}),
    ...(program.draw === undefined
      ? {}
      : {
          compute: buildDrawCompute<NonNullable<FXParticleKernelArtifact["compute"]>>(
            program.draw.stage,
          ),
        }),
  };
}
