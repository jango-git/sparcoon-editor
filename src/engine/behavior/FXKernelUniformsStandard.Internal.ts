import {
  FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM,
  FX_TRANSFORM_FEEDBACK_CAPACITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM,
  FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM,
} from "sparcoon";
import { FX_RENDER_BUDGET_MINIMUMS, fxPackedShape, packedVectors } from "sparcoon/editor";

import { FX_INHERIT_VECTOR_COMPONENTS } from "./FXInherit";

/** One uniform a fused program declares: its name and GLSL type, and its length when an array. */
export interface FXKernelUniform {
  readonly name: string;
  readonly glslTypeName: string;
  readonly length?: number;
}

/** `uniform <type> <name>;` of `uniform`, `uniform <type> <name>[<length>];` of an array. */
export function kernelUniformDeclaration(uniform: FXKernelUniform): string {
  const length = uniform.length === undefined ? "" : `[${uniform.length.toString()}]`;
  return `uniform ${uniform.glslTypeName} ${uniform.name}${length};`;
}

/**
 * The inherited uniform of a program whose births inherit `stride` floats: whole vec4s (see
 * `FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM`), the runtime's to set every pass. Absent when they
 * inherit nothing - the runtime's upload then finds no uniform, and does nothing.
 */
export function inheritedUniform(stride: number): FXKernelUniform | undefined {
  return stride === 0
    ? undefined
    : {
        name: FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM,
        glslTypeName: "vec4",
        length: Math.ceil(stride / FX_INHERIT_VECTOR_COMPONENTS),
      };
}

/** Float `offset` of the inherited uniform, `components` long, as one GLSL read: a value never
 *  crosses a vec4 (see `planInherits`), so it is one element's swizzle. */
export function inheritedUniformRead(offset: number, components: number): string {
  const element = Math.floor(offset / FX_INHERIT_VECTOR_COMPONENTS);
  const first = offset % FX_INHERIT_VECTOR_COMPONENTS;
  const swizzle = "xyzw".slice(first, first + components);
  return `${FX_TRANSFORM_FEEDBACK_INHERITED_UNIFORM}[${element.toString()}].${swizzle}`;
}

// Fixed, contract uniform names (sourced from sparcoon's behaviorTransformFeedbackLayout.ts, not
// re-derived here) every fused program declares unconditionally, regardless of whether this
// particular graph reads them - mirrors how `u_fxRandSeed` (rand's own contract, core/ir/
// FXFunctions.Internal.ts) is always declared too.
export const FIXED_UNIFORMS: readonly FXKernelUniform[] = [
  { glslTypeName: "int", name: FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_START_UNIFORM },
  { glslTypeName: "int", name: FX_TRANSFORM_FEEDBACK_SPAWN_RANGE_COUNT_UNIFORM },
  { glslTypeName: "int", name: FX_TRANSFORM_FEEDBACK_SPAWN_ID_BASE_UNIFORM },
  { glslTypeName: "int", name: FX_TRANSFORM_FEEDBACK_BIRTH_AGE_COUNT_UNIFORM },
  { glslTypeName: "vec2", name: FX_TRANSFORM_FEEDBACK_BIRTH_AGES_UNIFORM },
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
    .flatMap((uniform) => new Array<string>(uniform.length ?? 1).fill(uniform.glslTypeName))
    .filter((type) => !type.startsWith("sampler"));
  return (drawUniforms) =>
    packedVectors(
      [...declared, ...drawUniforms.map((type) => type.glslTypeName)].map(fxPackedShape),
    ) <= FX_RENDER_BUDGET_MINIMUMS.standard.vertexUniformVectors;
}
