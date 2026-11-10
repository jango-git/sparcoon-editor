import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_ID,
  FX_LIFETIME,
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "sparcoon";
import { floatGLSLType, packingOrder } from "sparcoon/editor";
import type {
  FXKernelBindingHandle,
  FXKernelBufferLayout,
  FXKernelWrite,
} from "./FXCompiledKernel";
import type { FXCompiledKernelStandard } from "./FXParticleBehaviorKernelStandard.Internal";
import { glslBufferAttributeName } from "./FXParticleBehaviorKernelStandard.Internal";

/**
 * The `new Function`-assembly layer's standard-tier sibling: turns a {@link FXCompiledKernelStandard}
 * into one complete, linkable WebGL2 transform-feedback vertex-shader program (plus a minimal
 * pass-through fragment shader, required to link but never rasterized). Fuses spawn and update
 * into ONE program with a per-invocation birth branch (`gl_VertexID` against a uniform-supplied
 * this-tick spawn range), chosen over two separate draws because transform feedback cannot read
 * and write the same buffer, and splitting `update`'s range around a wrapping spawn cursor
 * compounds badly.
 */

// Fixed, contract uniform names (sourced from sparcoon's behaviorTransformFeedbackLayout.ts, not
// re-derived here) every fused program declares unconditionally, regardless of whether this
// particular graph reads them - mirrors how `u_fxRandSeed` (rand's own contract, core/ir/
// FXFunctions.Internal.ts) is always declared too.
const FIXED_UNIFORM_DECLARATIONS: readonly string[] = [
  `uniform int ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM};`,
  `uniform int ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM};`,
  `uniform int ${FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM};`,
  `uniform int ${FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM};`,
  `uniform int ${FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM};`,
  `uniform float ${FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM};`,
  `uniform mat4 ${FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM};`,
  `uniform vec3 ${FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM};`,
  `uniform vec3 ${FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM};`,
];

/** A minimal, valid fragment shader - WebGL2 requires one to link any program, even a
 *  transform-feedback-only one never actually rasterized (`RASTERIZER_DISCARD` at draw time). */
export const FX_TRANSFORM_FEEDBACK_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
out vec4 fx_unused_fragColor;
void main(){
  fx_unused_fragColor = vec4(0.0);
}
`;

export interface FXFusedProgramStandard {
  readonly vertexSource: string;
  readonly fragmentSource: string;
  /** Varying names for `gl.transformFeedbackVaryings` - one per buffer, matching `buffers`' order. */
  readonly transformFeedbackVaryings: readonly string[];
  /** The particle slot's fields in the order they lie in it - {@link slotOrder}'s, not the
   *  target's. A buffer's index here is its attribute location and its place in the slot. */
  readonly buffers: readonly FXKernelBufferLayout[];
  readonly bindings: Readonly<Record<string, FXKernelBindingHandle>>;
}

/** Deterministic `out` (transform-feedback) varying name for a state buffer. */
function glslOutVaryingName(bufferName: string): string {
  return `out_${bufferName}`;
}

function glslTypeForBuffer(buffer: FXKernelBufferLayout): string {
  return floatGLSLType(buffer.stride, `assembleTransformFeedbackProgram: buffer "${buffer.name}"`);
}

/** Merges the two phases' graph-authored uniform declarations, deduped by exact text (two phases
 *  sharing a forced-name param produce identical text); a same-name different-type collision is a
 *  real authoring conflict and throws, the same way `compileToArtifacts.ts`'s `collectPhaseBindings`
 *  throws on a cross-phase binding value conflict for the JS backend. */
function mergeUniformDeclarations(spawn: readonly string[], update: readonly string[]): string[] {
  const byName = new Map<string, string>();
  const merged: string[] = [];
  for (const declaration of [...spawn, ...update]) {
    const name = declaration.split(" ")[2]?.replace(";", "");
    if (name === undefined) {
      throw new Error(`mergeUniformDeclarations: malformed declaration "${declaration}"`);
    }
    const existing = byName.get(name);
    if (existing === undefined) {
      byName.set(name, declaration);
      merged.push(declaration);
    } else if (existing !== declaration) {
      throw new Error(
        `mergeUniformDeclarations: uniform "${name}" declared differently across spawn/update ` +
          `("${existing}" vs "${declaration}")`,
      );
    }
  }
  return merged;
}

/** Merges the two phases' live binding handles by name, verifying a shared name (a param node
 *  used in both phases) started with the same value - the fused program has one uniform per name,
 *  so it needs one canonical handle, not two independently-drifting ones. */
function mergeBindings(
  spawn: Readonly<Record<string, FXKernelBindingHandle>>,
  update: Readonly<Record<string, FXKernelBindingHandle>>,
): Record<string, FXKernelBindingHandle> {
  const merged: Record<string, FXKernelBindingHandle> = { ...spawn };
  for (const [name, handle] of Object.entries(update)) {
    const existing = merged[name];
    if (existing === undefined) {
      merged[name] = handle;
    } else if (existing.value !== handle.value) {
      throw new Error(
        `mergeBindings: binding "${name}" has conflicting initial values across the spawn and ` +
          `update phases`,
      );
    }
  }
  return merged;
}

/** One buffer's default-then-graph-writes assignment for one branch (spawn or update). */
function assignBuffer(
  buffer: FXKernelBufferLayout,
  writes: readonly FXKernelWrite[],
  defaultExpr: string,
  epilogueOverrides: ReadonlyMap<number, string>,
): string[] {
  const varyingName = glslOutVaryingName(buffer.name);
  const lines = [`  ${varyingName} = ${defaultExpr};`];
  const bufferWrites = writes.filter((write) => write.buffer === buffer.name);
  const componentAssign = (offset: number, expr: string): string =>
    buffer.stride === 1
      ? `  ${varyingName} = ${expr};`
      : `  ${varyingName}.${["x", "y", "z", "w"][offset]} = ${expr};`;
  for (const write of bufferWrites) {
    lines.push(componentAssign(write.offset, write.expr));
  }
  for (const [offset, expr] of epilogueOverrides) {
    // Host-owned (age increment): always wins over a graph write, since the graph has no write
    // slot for age at all (FXParticleBehaviorTarget.ts's scalarWriteSlots never lists it) - this
    // never actually overrides a real graph write, just documents the ordering explicitly.
    lines.push(componentAssign(offset, expr));
  }
  return lines;
}

/**
 * The update target's buffers in the order the fused program lays its particle slot out: the
 * runtime's {@link packingOrder}, core `position`/`lifecycle` included, by raw buffer name. The
 * runtime never reorders a GPU kernel's buffers (index = attribute location = place in the slot)
 * and packs only fields lying side by side into one vertex attribute view, so this order is what
 * decides how few attributes the particle mesh and a trail's GPU history take. The runtime's own
 * function, not a copy, so the layout it packs over is the one it would have chosen; set-based, so
 * the order never depends on the order attributes were declared in.
 */
function slotOrder(buffers: readonly FXKernelBufferLayout[]): readonly FXKernelBufferLayout[] {
  return packingOrder(
    buffers.map((buffer) => ({ name: buffer.name, components: buffer.stride, buffer })),
  ).map((field) => field.buffer);
}

/** Assembles the fused spawn+update program from the two independently-compiled phases. */
export function assembleTransformFeedbackProgram(
  compiled: FXCompiledKernelStandard,
): FXFusedProgramStandard {
  const spawn = compiled.spawn;
  if (spawn === undefined) {
    throw new Error(
      "assembleTransformFeedbackProgram: a transform-feedback program requires a spawn phase " +
        "(update-only particle behavior is not a supported GPU shape)",
    );
  }
  const update = compiled.update;
  // The one ordered list every index below follows - input locations, varyings and the returned
  // `buffers` (which the artifact and the exported literal copy as they are).
  const buffers = slotOrder(update.buffers);

  // `layout(location = N)` binds each attribute to its buffer's own index in `buffers` - the
  // runtime binds by that index directly (`vertexAttribPointer(N, ...)`), never by looking an
  // attribute up by name, so no naming scheme needs to be shared with sparcoon for this part.
  const inDeclarations = buffers.map(
    (buffer, index) =>
      `layout(location = ${index.toString()}) in ${glslTypeForBuffer(buffer)} ${glslBufferAttributeName(buffer.name)};`,
  );
  const outDeclarations = buffers.map(
    (buffer) => `out ${glslTypeForBuffer(buffer)} ${glslOutVaryingName(buffer.name)};`,
  );
  const uniformDeclarations = [
    ...FIXED_UNIFORM_DECLARATIONS,
    ...mergeUniformDeclarations(spawn.uniformDeclarations, update.uniformDeclarations),
  ];
  const helpers = [...new Set([...spawn.helpers, ...update.helpers])];

  const lifecycleAgeOverride = new Map([
    [
      FX_AGE,
      `${glslBufferAttributeName(FX_CORE_LIFECYCLE)}.x + ${FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM}`,
    ],
  ]);
  // Host-owned, like age above: no write slot exists for id (FXParticleBehaviorTarget.ts's
  // scalarWriteSlots never lists it), so this never collides with a graph write.
  const lifecycleIdOverride = new Map([
    [FX_ID, `float(${FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM} + fx_relativeIndex)`],
  ]);

  const spawnAssignments = buffers.flatMap((buffer) =>
    // A freshly (over)written slot holds a previous, unrelated occupant's state - default every
    // component to zero, never to the stale `in_<buffer>` value (mirrors FXInstancedParticle.
    // createInstances's array.fill(0, ...) before the spawn kernel runs on the JS side).
    assignBuffer(
      buffer,
      spawn.writes,
      `${glslTypeForBuffer(buffer)}(0.0)`,
      buffer.name === FX_CORE_LIFECYCLE ? lifecycleIdOverride : new Map(),
    ),
  );
  const updateAssignments = buffers.flatMap((buffer) =>
    // In place, every component not explicitly written stays what it already was (mirrors the
    // JS backend mutating one persistent array in place) - except age, which is host-owned and
    // always advances, the GLSL analog of FXEmitter.tick()'s own age-increment loop.
    assignBuffer(
      buffer,
      update.writes,
      glslBufferAttributeName(buffer.name),
      buffer.name === FX_CORE_LIFECYCLE ? lifecycleAgeOverride : new Map(),
    ),
  );

  // A dead slot (age >= lifetime - the same test the render material culls by and the trail
  // history skips by) passes through untouched: the draw covers the whole capacity every tick, so
  // without this a mostly-empty burst emitter would run its full update (noise, collisions) over
  // every dead and never-spawned slot. Freezing age keeps the slot dead, and a never-spawned slot's
  // zeroed lifecycle (0 >= 0) counts as dead too.
  const lifecycleIn = glslBufferAttributeName(FX_CORE_LIFECYCLE);
  const component = (offset: number): string => ["x", "y", "z", "w"][offset] ?? "x";
  const deadCondition = `${lifecycleIn}.${component(FX_AGE)} >= ${lifecycleIn}.${component(FX_LIFETIME)}`;
  const passThroughAssignments = buffers.map(
    (buffer) => `    ${glslOutVaryingName(buffer.name)} = ${glslBufferAttributeName(buffer.name)};`,
  );

  const vertexSource = `#version 300 es
precision highp float;

${inDeclarations.join("\n")}

${outDeclarations.join("\n")}

${uniformDeclarations.join("\n")}

${helpers.join("\n\n")}

void main(){
  int fx_particleIndex = gl_VertexID;
  int fx_relativeIndex = (fx_particleIndex - ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM} + ${FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM}) % ${FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM};
  bool fx_isBirth = ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM} > 0 && fx_relativeIndex < ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM};
  if (fx_isBirth) {
${[...spawn.body.map((line) => `    ${line}`), ...spawnAssignments].join("\n")}
  } else if (${deadCondition}) {
${passThroughAssignments.join("\n")}
  } else {
${[...update.body.map((line) => `    ${line}`), ...updateAssignments].join("\n")}
  }
}
`;

  return {
    vertexSource,
    fragmentSource: FX_TRANSFORM_FEEDBACK_FRAGMENT_SOURCE,
    transformFeedbackVaryings: buffers.map((buffer) => glslOutVaryingName(buffer.name)),
    buffers,
    bindings: mergeBindings(spawn.bindings, update.bindings),
  };
}
