import type { FXParticleReads, FXSurfaceReads } from "sparcoon";
import {
  fxGraphVaryingAllowance,
  fxVaryingShape,
  packedVaryingVectors,
  type FXGLSLRenderTier,
} from "sparcoon/editor";
import type { FXValueType } from "../../core/socket/FXValueType";
import { FXShaderStage } from "../FXShaderStage";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import { canonicalAttributeSuffix } from "../../core/socket/FXAttribute";
import type { FXInputRate, FXTarget, FXTargetInput, FXTargetOutput } from "./FXTarget";

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
  { name: "PARTICLE_POSITION_X", type: FLOAT, stages: BOTH_STAGES, rate: "primitive" },
  { name: "PARTICLE_POSITION_Y", type: FLOAT, stages: BOTH_STAGES, rate: "primitive" },
  { name: "PARTICLE_POSITION_Z", type: FLOAT, stages: BOTH_STAGES, rate: "primitive" },
  // A single `vec3` (the `p_position` varying), so `builtin-attribute`'s position output
  // reads the core builtin symmetrically to the behavior side.
  { name: "PARTICLE_POSITION", type: VEC3, stages: BOTH_STAGES, rate: "primitive" },
  { name: "PARTICLE_AGE", type: FLOAT, stages: BOTH_STAGES, rate: "primitive" },
  { name: "PARTICLE_LIFETIME", type: FLOAT, stages: BOTH_STAGES, rate: "primitive" },
  { name: "PARTICLE_ID", type: FLOAT, stages: BOTH_STAGES, rate: "primitive" },
  { name: "p_uv", type: VEC2, stages: [FXShaderStage.FRAGMENT], rate: "vertex" },
  // World-space surface frame + position, built by the runtime from the billboard transform:
  // geometryNormal (surface normal), geometryTangent (u-axis tangent, spans the TBN with the
  // normal), worldPosition (fragment world position, for fresnel / view-direction).
  { name: "geometryNormal", type: VEC3, stages: [FXShaderStage.FRAGMENT], rate: "fragment" },
  { name: "geometryTangent", type: VEC3, stages: [FXShaderStage.FRAGMENT], rate: "fragment" },
  { name: "worldPosition", type: VEC3, stages: [FXShaderStage.FRAGMENT], rate: "fragment" },
  // Global clock (seconds since start), updated per frame by the material adapter + FXEmitter.
  { name: "u_time", type: FLOAT, stages: BOTH_STAGES, rate: "draw" },
  // Time elapsed since the previous frame (seconds), updated per frame likewise.
  { name: "u_deltaTime", type: FLOAT, stages: BOTH_STAGES, rate: "draw" },
  // View-space distance from the camera to the particle center, computed in the vertex stage
  // and interpolated. Enables distance-based fades.
  { name: "p_cameraDistance", type: FLOAT, stages: [FXShaderStage.FRAGMENT], rate: "vertex" },
  // Three declares and populates `modelMatrix` automatically; costs no per-frame plumbing.
  { name: "modelMatrix", type: MAT4, stages: BOTH_STAGES, rate: "draw" },
  // Three declares and updates `viewMatrix` in both prefixes (BOTH_STAGES also keeps a
  // stage-flexible reader like `look-at-camera` from failing the nominal-stage read check).
  { name: "viewMatrix", type: MAT4, stages: BOTH_STAGES, rate: "draw" },
  // Three declares `cameraPosition` in both prefixes; feeds billboards and fresnel.
  { name: "cameraPosition", type: VEC3, stages: BOTH_STAGES, rate: "draw" },
  // The emitter/mesh's world-space linear/angular velocity, pushed by FXEmitter/FXEffect each
  // tick. Unprefixed: a domain-shared builtin, also exposed by the behavior target, not a
  // render-local uniform.
  { name: "objectVelocity", type: VEC3, stages: BOTH_STAGES, rate: "draw" },
  { name: "objectAngularVelocity", type: VEC3, stages: BOTH_STAGES, rate: "draw" },
];

/** Varying (and render target-input) name a user attribute `name` is read through. */
export function attributeVaryingName(name: string): string {
  return `p_fx_${name}`;
}

/** The particle builtins backed by the core `position` buffer, and by the `lifecycle` one. */
const POSITION_INPUTS: ReadonlySet<string> = new Set([
  "PARTICLE_POSITION",
  "PARTICLE_POSITION_X",
  "PARTICLE_POSITION_Y",
  "PARTICLE_POSITION_Z",
]);
const LIFECYCLE_INPUTS: ReadonlySet<string> = new Set([
  "PARTICLE_AGE",
  "PARTICLE_LIFETIME",
  "PARTICLE_ID",
]);
const ATTRIBUTE_INPUT_PREFIX = attributeVaryingName("");

/**
 * What a stage reading the particle or trail target inputs `targetReads` (see
 * `FXCompiledStage.targetReads`) reads of each particle - the artifact's `particleReads`, from
 * which the runtime declares the attributes and varyings the stage needs. Every other input (the
 * camera, `p_uv`, the clock) is the runtime's own, not particle state.
 */
export function particleReadsOf(targetReads: readonly string[]): FXParticleReads {
  return {
    position: targetReads.some((name) => POSITION_INPUTS.has(name)),
    lifecycle: targetReads.some((name) => LIFECYCLE_INPUTS.has(name)),
    attributes: targetReads
      .filter((name) => name.startsWith(ATTRIBUTE_INPUT_PREFIX))
      .map((name) => name.slice(ATTRIBUTE_INPUT_PREFIX.length)),
  };
}

/**
 * What a fragment stage reading the target inputs `targetReads` reads of the world-space surface
 * frame - the artifact's `surfaceReads`, from which the runtime builds exactly the builtins (and
 * the varyings carrying them) the stage needs.
 */
export function surfaceReadsOf(targetReads: readonly string[]): FXSurfaceReads {
  return {
    normal: targetReads.includes("geometryNormal"),
    tangent: targetReads.includes("geometryTangent"),
    position: targetReads.includes("worldPosition"),
  };
}

/**
 * The varyings the runtime declares for the particle properties a fragment stage reading the
 * target inputs `targetReads` reads (see {@link particleReadsOf}): the core position and lifecycle
 * as a `vec3` each, an attribute at its own width - as `packedVaryingVectors` counts them.
 */
export function fragmentPropertyVaryings(
  target: FXTarget,
  targetReads: readonly string[],
): { readonly components: number; readonly count: number }[] {
  const reads = particleReadsOf(targetReads);
  const vec3 = { components: 3, count: 1 };
  return [
    ...(reads.position ? [vec3] : []),
    ...(reads.lifecycle ? [vec3] : []),
    ...reads.attributes.map((name) => {
      const input = target.inputs.find(
        (candidate) => candidate.name === attributeVaryingName(name),
      );
      if (input === undefined) {
        throw new Error(
          `fragmentPropertyVaryings: target "${target.name}" has no attribute "${name}"`,
        );
      }
      return { components: input.type.components, count: 1 };
    }),
  ];
}

/**
 * Whether what a graph carries from its vertex to its fragment stage fits what `tier` leaves a
 * graph beside the heaviest particle material (`fxGraphVaryingAllowance`), counted by the
 * runtime's own packing rule: the `carried` values and the particle properties a fragment stage
 * reading `lateReads` needs as varyings (see {@link fragmentPropertyVaryings}). `fragmentReads` -
 * what the fragment stage reads of the target at all - fixes the surface frame the material
 * builds, which no move between the stages changes (it is per fragment).
 */
export function crossingBudget(
  target: FXTarget,
  tier: FXGLSLRenderTier,
  fragmentReads: readonly string[],
): (carried: readonly FXValueType[], lateReads: readonly string[]) => boolean {
  const allowance = fxGraphVaryingAllowance(tier, surfaceReadsOf(fragmentReads));
  return (carried, lateReads) =>
    packedVaryingVectors([
      ...carried.map((type) => fxVaryingShape(type.glslTypeName)),
      ...fragmentPropertyVaryings(target, lateReads),
    ]) <= allowance;
}

/** Per-attribute render inputs: each requested attribute is readable in both stages through its
 *  `p_fx_<name>` varying, which the runtime's material fills from whichever packed attribute
 *  holds the field (or a constant zero when nothing writes it). */
function attributeRenderInputs(
  attributes: readonly FXAttributeRequest[],
  rate: FXInputRate,
): readonly FXTargetInput[] {
  return attributes.map((attribute) => ({
    name: attributeVaryingName(attribute.name),
    type: attribute.type,
    stages: BOTH_STAGES,
    rate,
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
// honored only in `blending`), `intensity` (a multiplier on the color alone, never its alpha, in every
// mode) and `alphaThreshold` (discard cutoff, honored in every mode but `opaque`).
const COMPOSITING_OUTPUTS: readonly FXTargetOutput[] = [
  { slot: "additivity", type: FLOAT, stage: FXShaderStage.FRAGMENT, required: false },
  { slot: "intensity", type: FLOAT, stage: FXShaderStage.FRAGMENT, required: false },
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
    inputs: [...PARTICLE_BUILTINS, ...attributeRenderInputs(attributes, "primitive")],
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

/** Particle builtins a trail does not expose: a ribbon segment has no authored surface frame, so
 *  every node reading `geometryNormal` or `geometryTangent` is kept out of a trail graph - the
 *  lighting nodes (ambient/lambert shading), normal-map, spherical-normal and surface-normal.
 *  A node that reads only the view (fresnel) stays. */
const TRAIL_EXCLUDED_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  "geometryNormal",
  "geometryTangent",
]);

/**
 * The trail render builtins: every particle builtin - each one interpolated along the ribbon
 * between two recorded points of the particle's path, so per vertex, not per primitive - minus the
 * surface frame. `p_uv` means something else here: x runs along the trail (0 at the particle, 1 at
 * the tail) and y across it (0 -> 1), and it is readable in the vertex stage too, for a `width`
 * that tapers along the trail.
 */
const TRAIL_BUILTINS: readonly FXTargetInput[] = PARTICLE_BUILTINS.filter(
  (input) => !TRAIL_EXCLUDED_BUILTIN_NAMES.has(input.name),
).map((input) => ({
  ...input,
  stages: input.name === "p_uv" ? BOTH_STAGES : input.stages,
  rate: input.rate === "primitive" ? "vertex" : input.rate,
}));

/** The ribbon's width in world units at a vertex; `0.1` when unwired. */
const TRAIL_WIDTH_OUTPUT: FXTargetOutput = {
  slot: "width",
  type: FLOAT,
  stage: FXShaderStage.VERTEX,
  required: false,
};

/** The trail surface interface: `albedo`, the compositing slots, and the ribbon `width`. */
const TRAIL_OUTPUTS: readonly FXTargetOutput[] = [
  { slot: "albedo", type: VEC4, stage: FXShaderStage.FRAGMENT, required: true },
  ...COMPOSITING_OUTPUTS,
  TRAIL_WIDTH_OUTPUT,
];

/** The trail render target (an emitter's trail graph), with a `p_fx_<name>` input per requested
 *  attribute - read off the particle's recorded path like every other builtin. */
export function buildTrailTarget(attributes: readonly FXAttributeRequest[] = []): FXTarget {
  return {
    name: `trail${canonicalAttributeSuffix(attributes)}`,
    inputs: [...TRAIL_BUILTINS, ...attributeRenderInputs(attributes, "vertex")],
    outputs: TRAIL_OUTPUTS,
  };
}

/** The trail render target with no user attributes. */
export const FX_TRAIL_TARGET: FXTarget = buildTrailTarget();
