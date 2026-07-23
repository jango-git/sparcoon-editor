import type {
  FXAttributeDecl,
  FXBehaviorArtifact,
  FXGeometrySource,
  FXParticleKernelArtifact,
  FXRenderArtifact,
  FXRenderMode,
  FXUniformInit,
  FXValueSlot,
} from "sparcoon";
import type { Texture } from "three";
import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import type { FXCompiledShader } from "../render/compiler/FXCompiledShader";
import type { FXCompiledKernel, FXCompiledKernelPhase } from "../behavior/FXCompiledKernel";
import type { FXFusedProgramStandard } from "../behavior/FXKernelBuildStandard.Internal";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
} from "../behavior/FXParticleBehaviorKernel.Internal";
import { uniformTypes } from "./artifactLiterals";

/**
 * In-memory assembler: turns the compiler's IR into the runtime's {@link FXRenderArtifact} /
 * {@link FXBehaviorArtifact} objects, the runnable twin of {@link emitEffectModule} (which
 * serializes the same IR to ESM text) - used to drive a live preview without a bundler round-trip.
 *
 * The value slots are fresh objects that only snapshot the current handle values, deliberately
 * NOT the editor's live handles: a value edit reaches the emitter through
 * {@link FXEmitter.applyValues}, not through shared object identity.
 */

/** `{name, components}` decls the runtime merges to size the shared attribute buffers. */
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

/** Assembles the render artifact from a compiled shader (fresh uniform value slots). */
export function assembleRenderArtifact(
  shader: FXCompiledShader,
  lightingIntrinsics: readonly string[],
  geometry: FXGeometrySource,
  attributes: readonly FXAttributeRequest[],
  renderMode: FXRenderMode,
): FXRenderArtifact {
  const types = uniformTypes(shader.uniformDeclarations);
  const uniforms: Record<string, FXUniformInit> = {};
  for (const [name, handle] of Object.entries(shader.uniforms)) {
    if (handle.external !== undefined) {
      // An external sampler (a Texture): declared, but the host binds the texture by
      // slot name - no baked value.
      uniforms[name] = { type: "sampler2D", external: handle.external };
      continue;
    }
    // A fresh slot snapshotting the handle's current value (number/vector/texture); the
    // material binds this object, and applyValues scrubs it - the editor handle is not shared.
    uniforms[name] = toUniformInit(handle.value, types.get(name) ?? "float");
  }
  return {
    lightingIntrinsics,
    geometry,
    options: { renderMode },
    uniformDeclarations: [...shader.uniformDeclarations],
    vertex: {
      varyingDeclarations: [...shader.vertex.varyingDeclarations],
      helperFunctions: [...shader.vertex.helperFunctions],
      body: [...shader.vertex.body],
    },
    fragment: {
      varyingDeclarations: [...shader.fragment.varyingDeclarations],
      helperFunctions: [...shader.fragment.helperFunctions],
      body: [...shader.fragment.body],
    },
    outputs: { ...shader.outputs },
    uniforms,
    attributeReads: attributeDecls(attributes),
  };
}

/** The single `bindings` record both phases share, as fresh {@link FXValueSlot}s. A same-named
 *  binding carrying a different value across phases would corrupt one phase, so it is rejected
 *  loudly rather than silently overwritten. */
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

/** Assembles the behavior artifact from a compiled kernel. `spawn`/`update` are the real
 *  `new Function`-built kernels; the binding slots are fresh, scrubbed via
 *  {@link FXEmitter.applyValues}. */
export function assembleBehaviorArtifact(
  kernel: FXCompiledKernel,
  attributes: readonly FXAttributeRequest[],
): FXBehaviorArtifact {
  const bindings = mergeBindingSlots(kernel);
  const update = buildParticleUpdateKernel(kernel);
  const buffers = kernel.update.buffers.map((buffer) => ({
    name: buffer.name,
    stride: buffer.stride,
  }));
  const base: FXBehaviorArtifact = {
    buffers,
    attributeWrites: attributeDecls(attributes),
    bindings,
    updateWrittenBuffers: [...kernel.update.writtenBuffers],
    update,
  };
  if (kernel.spawn === undefined) {
    return base;
  }
  return {
    ...base,
    spawn: buildParticleSpawnKernel(kernel),
    spawnWrittenBuffers: [...kernel.spawn.writtenBuffers],
  };
}

/** Assembles the standard-tier (GPU/transform-feedback) behavior artifact from a fused program -
 *  the {@link assembleBehaviorArtifact} sibling for a live GPU-driven emitter (fresh binding value
 *  slots, same reasoning as {@link mergeBindingSlots}). */
export function assembleGpuKernelArtifact(
  program: FXFusedProgramStandard,
): FXParticleKernelArtifact {
  const bindings: Record<string, FXValueSlot<number | Float32Array>> = {};
  for (const [name, handle] of Object.entries(program.bindings)) {
    bindings[name] = { value: handle.value };
  }
  return {
    vertexSource: program.vertexSource,
    fragmentSource: program.fragmentSource,
    buffers: program.buffers.map((buffer) => ({ name: buffer.name, stride: buffer.stride })),
    transformFeedbackVaryings: [...program.transformFeedbackVaryings],
    bindings,
  };
}
