import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_ID,
  FX_PARTICLE_ID_RANGE,
  FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM,
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "sparcoon";
import { floatGLSLType } from "sparcoon/editor";

import { type FXGLSLHelperName, glslHelperSource } from "../core/ir/FXHelpers.Internal";
import type { FXValueType } from "../core/socket/FXValueType";
import type {
  FXKernelBindingHandle,
  FXKernelBufferLayout,
  FXKernelResourceFields,
  FXKernelWrite,
} from "./FXCompiledKernel";
import { agedLifecycleAgeGLSL, deadSlotGLSL } from "./FXKernelLifecycle.Internal";
import { kernelResourceFields } from "./FXKernelShared.Internal";
import {
  FIXED_UNIFORMS,
  type FXKernelUniform,
  kernelUniformDeclaration,
} from "./FXKernelUniformsStandard.Internal";
import type {
  FXCompiledKernelDrawStage,
  FXCompiledKernelStandard,
} from "./FXParticleBehaviorKernelStandard.Internal";
import {
  BIRTH_AGE_LOCAL,
  BIRTH_MODEL_MATRIX_LOCAL,
  glslBufferAttributeName,
  glslNewbornSlotName,
} from "./FXParticleBehaviorKernelStandard.Internal";

/**
 * Builds one WebGL2 transform-feedback program from the compiled phases, plus a pass-through
 * fragment shader that only has to link. Spawn and update share one program with a birth branch
 * (`gl_VertexID` against the pass's spawn range): transform feedback cannot read and write one
 * buffer, and splitting update's range around a wrapping spawn cursor is worse.
 */

/**
 * Minimal fragment shader: WebGL2 needs one to link, `RASTERIZER_DISCARD` skips it at draw time.
 */
export const FX_TRANSFORM_FEEDBACK_FRAGMENT_SOURCE = `#version 300 es
precision highp float;
out vec4 fx_unused_fragColor;
void main(){
  fx_unused_fragColor = vec4(0.0);
}
`;

/**
 * The birth branch's first lines: the newborn's age - the last `u_fxBirthAgeCount` births of the
 * pass's range were born earlier in its tick, aged by `u_fxBirthAges` (first, step); the rest at
 * its end - and the model matrix as of its birth, its translation moved back along the emitter's
 * velocity by that age.
 */
const BIRTH_PROLOGUE: readonly string[] = [
  `int fx_birthAgeIndex = fx_relativeIndex - (${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM} - ${FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM});`,
  `float ${BIRTH_AGE_LOCAL} = fx_birthAgeIndex >= 0 ? ${FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM}.x + float(fx_birthAgeIndex) * ${FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM}.y : 0.0;`,
  `mat4 ${BIRTH_MODEL_MATRIX_LOCAL} = ${FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM};`,
  `${BIRTH_MODEL_MATRIX_LOCAL}[3].xyz -= ${FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM} * ${BIRTH_AGE_LOCAL};`,
];

/** Its resources are sampler uniforms the runtime binds textures to (see {@link FXKernelResourceFields}). */
export interface FXFusedProgramStandard extends FXKernelResourceFields {
  /** The vertex shader's lines; a helper stands for its whole source (see {@link fusedVertexSource}). */
  readonly vertexLines: readonly FXKernelSourceLine[];
  readonly fragmentSource: string;
  /** Varying names for `gl.transformFeedbackVaryings` - one per buffer, matching `buffers`' order. */
  readonly transformFeedbackVaryings: readonly string[];
  /** The particle slot's fields in the order they lie in it - the target's. A buffer's index here
   *  is its attribute location and its place in the slot. */
  readonly buffers: readonly FXKernelBufferLayout[];
  readonly bindings: Readonly<Record<string, FXKernelBindingHandle>>;
  /** Both phases' draw stages as one `compute`, and every draw uniform it fills, by type. */
  readonly draw?: FXCompiledKernelDrawStage;
  /** Whether a phase reads the scene depth; absent when neither does. */
  readonly sceneDepth?: true;
}

export type FXKernelSourceLine = string | { readonly helper: FXGLSLHelperName };

export function fusedVertexSource(program: FXFusedProgramStandard): string {
  return program.vertexLines
    .map((line) => (typeof line === "string" ? line : glslHelperSource(line.helper)))
    .join("\n");
}

function glslOutVaryingName(bufferName: string): string {
  return `out_${bufferName}`;
}

function glslTypeForBuffer(buffer: FXKernelBufferLayout): string {
  return floatGLSLType(buffer.stride, `assembleTransformFeedbackProgram: buffer "${buffer.name}"`);
}

/** Merges both phases' uniforms by name. Same name with a different type throws. */
function mergeUniforms(
  spawn: readonly FXKernelUniform[],
  update: readonly FXKernelUniform[],
): FXKernelUniform[] {
  const byName = new Map<string, FXKernelUniform>();
  for (const uniform of [...spawn, ...update]) {
    const existing = byName.get(uniform.name);
    if (existing === undefined) {
      byName.set(uniform.name, uniform);
    } else if (existing.glslTypeName !== uniform.glslTypeName) {
      throw new Error(
        `mergeUniforms: uniform "${uniform.name}" declared differently across spawn/update ` +
          `(${existing.glslTypeName} vs ${uniform.glslTypeName})`,
      );
    }
  }
  return [...byName.values()];
}

/**
 * Merges both phases' binding handles by name. A shared name needs one handle with the same
 * starting value, since the program has one uniform per name.
 */
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
    // Age is host-owned: it always advances, the graph has no write slot for it.
    lines.push(componentAssign(offset, expr));
  }
  return lines;
}

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
  // Buffer order: attribute locations, varyings and `buffers` all follow the target's slot order.
  const buffers = update.buffers;

  // `location` is the buffer's index in `buffers`, and the runtime binds by index, not by name.
  const inDeclarations = buffers.map(
    (buffer, index) =>
      `layout(location = ${index.toString()}) in ${glslTypeForBuffer(buffer)} ${glslBufferAttributeName(buffer.name)};`,
  );
  const outDeclarations = buffers.map(
    (buffer) => `out ${glslTypeForBuffer(buffer)} ${glslOutVaryingName(buffer.name)};`,
  );
  const uniformDeclarations = [
    ...FIXED_UNIFORMS,
    ...mergeUniforms(spawn.uniforms, update.uniforms),
  ].map(kernelUniformDeclaration);
  const helpers = [...new Set([...spawn.helpers, ...update.helpers])];

  const lifecycleAgeOverride = new Map([
    [
      FX_AGE,
      agedLifecycleAgeGLSL(
        glslBufferAttributeName(FX_CORE_LIFECYCLE),
        FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
        update.kill,
      ),
    ],
  ]);
  const newbornLifecycle = glslNewbornSlotName(FX_CORE_LIFECYCLE);
  const newbornSlots = buffers.flatMap((buffer) => {
    const type = glslTypeForBuffer(buffer);
    const name = glslNewbornSlotName(buffer.name);
    return buffer.name === FX_CORE_LIFECYCLE
      ? [
          `${type} ${name} = ${type}(0.0);`,
          `${name}[${String(FX_AGE)}] = ${BIRTH_AGE_LOCAL};`,
          // Modulo the id range, as the runtime wraps the base (see FX_PARTICLE_ID_RANGE).
          `${name}[${String(FX_ID)}] = float((${FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM} + fx_relativeIndex) % ${String(FX_PARTICLE_ID_RANGE)});`,
        ]
      : [`${type} ${name} = ${type}(0.0);`];
  });
  const lifecycleBirthOverride = new Map([
    [FX_AGE, BIRTH_AGE_LOCAL],
    [FX_ID, `${newbornLifecycle}[${String(FX_ID)}]`],
  ]);

  const spawnAssignments = buffers.flatMap((buffer) =>
    // A reused slot holds another particle's state: zero every component instead of reading
    // `in_<buffer>`.
    assignBuffer(
      buffer,
      spawn.writes,
      `${glslTypeForBuffer(buffer)}(0.0)`,
      buffer.name === FX_CORE_LIFECYCLE ? lifecycleBirthOverride : new Map(),
    ),
  );
  const updateAssignments = buffers.flatMap((buffer) =>
    // Update keeps unwritten components as they are. Age always advances.
    assignBuffer(
      buffer,
      update.writes,
      glslBufferAttributeName(buffer.name),
      buffer.name === FX_CORE_LIFECYCLE ? lifecycleAgeOverride : new Map(),
    ),
  );

  // A dead slot (age >= lifetime, which a zeroed never-spawned slot also satisfies) passes through,
  // so a mostly empty burst does not run the full update over every slot.
  const lifecycleIn = glslBufferAttributeName(FX_CORE_LIFECYCLE);
  const deadCondition = deadSlotGLSL(lifecycleIn);
  const passThroughAssignments = buffers.map(
    (buffer) => `    ${glslOutVaryingName(buffer.name)} = ${glslBufferAttributeName(buffer.name)};`,
  );

  // A 2D sampler is lowp by default in GLSL ES 3.00, and a 3D one has no default - a surface table
  // holds positions.
  const declarations = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;

${inDeclarations.join("\n")}

${outDeclarations.join("\n")}

${uniformDeclarations.join("\n")}
`;
  const main = `
void main(){
  int fx_particleIndex = gl_VertexID;
  int fx_relativeIndex = (fx_particleIndex - ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM} + ${FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM}) % ${FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM};
  bool fx_isBirth = ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM} > 0 && fx_relativeIndex < ${FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM};
  if (fx_isBirth) {
${[...BIRTH_PROLOGUE, ...newbornSlots, ...spawn.body].map((line) => `    ${line}`).join("\n")}
${spawnAssignments.join("\n")}
  } else if (${deadCondition}) {
${passThroughAssignments.join("\n")}
  } else {
${[...update.body.map((line) => `    ${line}`), ...updateAssignments].join("\n")}
  }
}
`;
  const vertexLines: FXKernelSourceLine[] = [
    ...declarations.split("\n"),
    ...helpers.map((helper) => ({ helper })),
    ...main.split("\n"),
  ];

  const draw = fuseDrawStages([spawn.draw, update.draw]);
  return {
    vertexLines,
    fragmentSource: FX_TRANSFORM_FEEDBACK_FRAGMENT_SOURCE,
    transformFeedbackVaryings: buffers.map((buffer) => glslOutVaryingName(buffer.name)),
    buffers,
    bindings: mergeBindings(spawn.bindings, update.bindings),
    ...kernelResourceFields(compiled),
    ...(draw === undefined ? {} : { draw }),
    ...(spawn.sceneDepth === true || update.sceneDepth === true ? { sceneDepth: true } : {}),
  };
}

/**
 * Both phases' draw stages as one compute. Each phase's statements get their own block, since
 * locals are only named apart within a phase.
 */
function fuseDrawStages(
  stages: readonly (FXCompiledKernelDrawStage | undefined)[],
): FXCompiledKernelDrawStage | undefined {
  const present = stages.filter((stage): stage is FXCompiledKernelDrawStage => stage !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  return {
    stage: {
      statements: present.flatMap(({ stage }) => [
        "{",
        ...stage.statements.map((statement) => `  ${statement}`),
        "}",
      ]),
      helpers: [...new Set(present.flatMap(({ stage }) => stage.helpers))],
    },
    uniforms: Object.assign({}, ...present.map(({ uniforms }) => uniforms)) as Record<
      string,
      FXValueType
    >,
  };
}
