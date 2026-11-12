import {
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
import { FX_RENDER_BUDGET_MINIMUMS, fxPackedShape, packedVectors } from "sparcoon/editor";

/** One uniform a fused program declares: its name and GLSL type. */
export interface FXKernelUniform {
  readonly name: string;
  readonly glslTypeName: string;
}

/** `uniform <type> <name>;` of `uniform`. */
export function kernelUniformDeclaration(uniform: FXKernelUniform): string {
  return `uniform ${uniform.glslTypeName} ${uniform.name};`;
}

// Fixed, contract uniform names (sourced from sparcoon's behaviorTransformFeedbackLayout.ts, not
// re-derived here) every fused program declares unconditionally, regardless of whether this
// particular graph reads them - mirrors how `u_fxRandSeed` (rand's own contract, core/ir/
// FXFunctions.Internal.ts) is always declared too.
export const FIXED_UNIFORMS: readonly FXKernelUniform[] = [
  { glslTypeName: "int", name: FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM },
  { glslTypeName: "int", name: FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM },
  { glslTypeName: "int", name: FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM },
  { glslTypeName: "int", name: FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM },
  { glslTypeName: "int", name: FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM },
  { glslTypeName: "float", name: FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM },
  { glslTypeName: "mat4", name: FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM },
  { glslTypeName: "vec3", name: FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM },
  { glslTypeName: "vec3", name: FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM },
];

/**
 * Whether draw uniforms fit a fused transform-feedback program (WebGL2 only, a vertex shader)
 * beside its contract uniforms and `graphUniforms` (the bindings and draw uniforms both its phases
 * declare so far): against Standard's vertex uniform vectors, by the runtime's packing rule. A
 * sampler takes a texture unit, no vector.
 */
export function transformFeedbackUniformBudget(
  graphUniforms: readonly FXKernelUniform[],
): (drawUniforms: readonly { readonly glslTypeName: string }[]) => boolean {
  const declared = [...FIXED_UNIFORMS, ...graphUniforms]
    .map((uniform) => uniform.glslTypeName)
    .filter((type) => !type.startsWith("sampler"));
  return (drawUniforms) =>
    packedVectors(
      [...declared, ...drawUniforms.map((type) => type.glslTypeName)].map(fxPackedShape),
    ) <= FX_RENDER_BUDGET_MINIMUMS.standard.vertexUniformVectors;
}
