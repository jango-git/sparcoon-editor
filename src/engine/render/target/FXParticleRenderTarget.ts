import { FXShaderStage } from "../FXShaderStage";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import { canonicalAttributeSuffix } from "../../core/socket/FXAttribute";
import type { FXTarget, FXTargetInput, FXTargetOutput } from "./FXTarget";

const FLOAT = FX_VALUE_TYPES.float;
const VEC2 = FX_VALUE_TYPES.vec2;
const VEC3 = FX_VALUE_TYPES.vec3;
const VEC4 = FX_VALUE_TYPES.vec4;
const MAT4 = FX_VALUE_TYPES.mat4;

/** Both shader stages - most particle builtins are readable in either. */
const BOTH_STAGES: readonly FXShaderStage[] = [FXShaderStage.VERTEX, FXShaderStage.FRAGMENT];

/** The core per-particle builtins the particle shaders expose, backed by the two split-buffer
 *  varyings (`p_position`, `p_lifecycle`) via `FX_CORE_PARTICLE_DEFINES`. Velocity, scale,
 *  rotation etc. are ordinary user-declared attributes, not target builtins. */
const PARTICLE_BUILTINS: readonly FXTargetInput[] = [
  { name: "PARTICLE_POSITION_X", type: FLOAT, stages: BOTH_STAGES },
  { name: "PARTICLE_POSITION_Y", type: FLOAT, stages: BOTH_STAGES },
  { name: "PARTICLE_POSITION_Z", type: FLOAT, stages: BOTH_STAGES },
  // A single `vec3` (the `p_position` varying), so `builtin-attribute`'s position output
  // reads the core builtin symmetrically to the behavior side.
  { name: "PARTICLE_POSITION", type: VEC3, stages: BOTH_STAGES },
  { name: "PARTICLE_AGE", type: FLOAT, stages: BOTH_STAGES },
  { name: "PARTICLE_LIFETIME", type: FLOAT, stages: BOTH_STAGES },
  { name: "PARTICLE_ID", type: FLOAT, stages: BOTH_STAGES },
  { name: "p_uv", type: VEC2, stages: [FXShaderStage.FRAGMENT] },
  // World-space surface frame + position, built by the runtime from the billboard transform:
  // geometryNormal (surface normal), geometryTangent (u-axis tangent, spans the TBN with the
  // normal), worldPosition (fragment world position, for fresnel / view-direction).
  { name: "geometryNormal", type: VEC3, stages: [FXShaderStage.FRAGMENT] },
  { name: "geometryTangent", type: VEC3, stages: [FXShaderStage.FRAGMENT] },
  { name: "worldPosition", type: VEC3, stages: [FXShaderStage.FRAGMENT] },
  // Global clock (seconds since start), updated per frame by the material adapter + FXEmitter.
  { name: "u_time", type: FLOAT, stages: BOTH_STAGES },
  // Time elapsed since the previous frame (seconds), updated per frame likewise.
  { name: "u_deltaTime", type: FLOAT, stages: BOTH_STAGES },
  // View-space distance from the camera to the particle center, computed in the vertex stage
  // and interpolated. Enables distance-based fades.
  { name: "p_cameraDistance", type: FLOAT, stages: [FXShaderStage.FRAGMENT] },
  // Three declares and populates `modelMatrix` automatically; costs no per-frame plumbing.
  { name: "modelMatrix", type: MAT4, stages: BOTH_STAGES },
  // Three declares and updates `viewMatrix` in both prefixes (BOTH_STAGES also keeps a
  // stage-flexible reader like `look-at-camera` from failing the nominal-stage read check).
  { name: "viewMatrix", type: MAT4, stages: BOTH_STAGES },
  // Three declares `cameraPosition` in both prefixes; feeds billboards and fresnel.
  { name: "cameraPosition", type: VEC3, stages: BOTH_STAGES },
  // The emitter/mesh's world-space linear/angular velocity, pushed by FXEmitter/FXEffect each
  // tick. Unprefixed: a domain-shared builtin, also exposed by the behavior target, not a
  // render-local uniform.
  { name: "objectVelocity", type: VEC3, stages: BOTH_STAGES },
  { name: "objectAngularVelocity", type: VEC3, stages: BOTH_STAGES },
];

/** Varying (and render target-input) name a user attribute `name` is read through. */
export function attributeVaryingName(name: string): string {
  return `p_fx_${name}`;
}

/** Per-attribute render inputs: each requested attribute is readable in both stages through its
 *  `p_fx_<name>` varying, mirrored from `a_fx_<name>` by the material adapter. */
function attributeRenderInputs(
  attributes: readonly FXAttributeRequest[],
): readonly FXTargetInput[] {
  return attributes.map((attribute) => ({
    name: attributeVaryingName(attribute.name),
    type: attribute.type,
    stages: BOTH_STAGES,
  }));
}

/**
 * Optional per-vertex transform outputs, both `mat4`, defaulting to identity when unwired:
 *   worldPos = particleCenter + (particleTransform * (vertexTransform * meshVertex)).xyz
 * `vertexTransform` deforms the mesh in its own local space; `particleTransform` places/orients
 * the whole particle (a billboard is this slot fed a camera-facing rotation). Particle-only: a
 * VFX mesh is posed by its own scene transform, so the mesh target omits `particleTransform`.
 */
const VERTEX_TRANSFORM_OUTPUT: FXTargetOutput = {
  slot: "vertexTransform",
  type: MAT4,
  stage: FXShaderStage.VERTEX,
  required: false,
};
const PARTICLE_TRANSFORM_OUTPUT: FXTargetOutput = {
  slot: "particleTransform",
  type: MAT4,
  stage: FXShaderStage.VERTEX,
  required: false,
};

// Compositing slots the `$out` surface sink owns: `additivity` (0 = normal "over" -> 1 = additive,
// honored only in `blending`) and `alphaThreshold` (discard cutoff, honored in every mode but `opaque`).
const COMPOSITING_OUTPUTS: readonly FXTargetOutput[] = [
  { slot: "additivity", type: FLOAT, stage: FXShaderStage.FRAGMENT, required: false },
  { slot: "alphaThreshold", type: FLOAT, stage: FXShaderStage.FRAGMENT, required: false },
];

/** The surface slots shared by both render hosts (particle + VFX mesh): `albedo` (required), the
 *  compositing slots, and the local-space `vertexTransform`. Shading normal/emission are node
 *  inputs, not surface slots. */
const SHARED_SURFACE_OUTPUTS: readonly FXTargetOutput[] = [
  { slot: "albedo", type: VEC4, stage: FXShaderStage.FRAGMENT, required: true },
  ...COMPOSITING_OUTPUTS,
  VERTEX_TRANSFORM_OUTPUT,
];

/** The particle surface interface: the shared slots plus the particle-only `particleTransform`. */
const SURFACE_OUTPUTS: readonly FXTargetOutput[] = [
  ...SHARED_SURFACE_OUTPUTS,
  PARTICLE_TRANSFORM_OUTPUT,
];

/** The particle render target, extended with a `p_fx_<name>` input per requested attribute. The
 *  attribute set is folded into the target name, salting the structural hash. */
export function buildParticleTarget(attributes: readonly FXAttributeRequest[] = []): FXTarget {
  return {
    name: `particle${canonicalAttributeSuffix(attributes)}`,
    inputs: [...PARTICLE_BUILTINS, ...attributeRenderInputs(attributes)],
    outputs: SURFACE_OUTPUTS,
  };
}

/** The particle render target with no user attributes (the common case). */
export const FX_PARTICLE_TARGET: FXTarget = buildParticleTarget();

/** Per-particle builtins a VFX mesh has no runtime for - excluded from {@link MESH_BUILTINS},
 *  derived (not hand-copied) so a future {@link PARTICLE_BUILTINS} addition reaches it automatically. */
const PARTICLE_ONLY_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  "PARTICLE_POSITION_X",
  "PARTICLE_POSITION_Y",
  "PARTICLE_POSITION_Z",
  "PARTICLE_POSITION",
  "PARTICLE_AGE",
  "PARTICLE_LIFETIME",
  "PARTICLE_ID",
  "p_cameraDistance",
]);

/** The VFX-mesh render builtins: the particle builtins minus everything per-particle. A VFX mesh
 *  is a single, non-instanced mesh with no particle state and no user attributes. */
const MESH_BUILTINS: readonly FXTargetInput[] = PARTICLE_BUILTINS.filter(
  (input) => !PARTICLE_ONLY_BUILTIN_NAMES.has(input.name),
);

/** The VFX-mesh render target. No particle builtins and no per-particle attributes, so a render
 *  node reading one (`custom-attribute`, `life-ratio`, `dissolve`) fails validation against
 *  it - that missing-input rejection IS the intended palette restriction. */
export const FX_MESH_TARGET: FXTarget = {
  name: "mesh",
  inputs: MESH_BUILTINS,
  outputs: SHARED_SURFACE_OUTPUTS,
};
