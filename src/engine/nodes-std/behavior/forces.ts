import { defineNode } from "../../core/nodes/defineNode";
import type { FXNodeDefinition, FXExprBuilderApi } from "../../core/nodes/defineNode";
import type { FXExpr } from "../../core/ir/FXExpr";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import { FX_FBM_MAX_OCTAVES } from "../../core/ir/FXFunctions.Internal";
import { DT_INPUT, rand, TWO_PI, VELOCITY_INPUT } from "./common";

const VEC3 = FX_VALUE_TYPES.vec3;

/**
 * Standard-library behavior force nodes, authored via {@link defineNode}. Most integrate a force
 * over `dt` into velocity (defaulting to the particle's own); `firework` is a spawn-phase seeder.
 */

/** Fixed, mutually-incommensurate offsets decorrelating the three velocity channels sampled from
 *  one shared fBm field - same role as curl-noise's derivative-channel offsets in shared/noise.ts. */
const TURBULENCE_CHANNEL_OFFSET = {
  x: [0, 0, 0],
  y: [19.1, 7.3, 41.9],
  z: [41.3, 53.7, 11.7],
} as const;

/** Cross product `a x b` of two `vec3` expressions, built component-wise. */
function cross(a: FXExpr, b: FXExpr, fn: FXExprBuilderApi): FXExpr {
  const ax = fn.swizzle(a, "x");
  const ay = fn.swizzle(a, "y");
  const az = fn.swizzle(a, "z");
  const bx = fn.swizzle(b, "x");
  const by = fn.swizzle(b, "y");
  const bz = fn.swizzle(b, "z");
  return fn.construct(
    VEC3,
    fn.sub(fn.mul(ay, bz), fn.mul(az, by)),
    fn.sub(fn.mul(az, bx), fn.mul(ax, bz)),
    fn.sub(fn.mul(ax, by), fn.mul(ay, bx)),
  );
}

/** Constant acceleration, `v += acceleration * dt` (use downward as gravity). */
export const fxGravity = defineNode({
  type: "gravity",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    acceleration: { type: "vec3", value: [0, -9.81, 0] },
    dt: DT_INPUT,
  },
  outputs: { velocity: { type: "vec3" } },
  params: {},
  // vec3 * float (3 multiplies) + vec3 add (3).
  cost: 6,
  build: ({ inputs, fn }) => ({
    velocity: fn.add(inputs["velocity"], fn.mul(inputs["acceleration"], inputs["dt"])),
  }),
});

/** Exponential velocity damping, `v *= exp(-damping * dt)` (frame-rate independent). */
export const fxDrag = defineNode({
  type: "drag",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    damping: { type: "float", value: 1, min: 0, max: 50, step: 0.1 },
    dt: DT_INPUT,
  },
  outputs: { velocity: { type: "vec3" } },
  params: {},
  // exp(-damping*dt): mul(1) + negate(1) + exp(4), then vec3 * scalar factor (3).
  cost: 9,
  build: ({ inputs, local, fn }) => {
    const factor = local(
      "dragFactor",
      fn.call("exp", fn.neg(fn.mul(inputs["damping"], inputs["dt"]))),
    );
    return { velocity: fn.mul(inputs["velocity"], factor) };
  },
});

/** Accelerates particles toward/away from a point; falloff mode is structural. */
export const fxPointForce = defineNode({
  type: "point-force",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    center: { type: "vec3", value: [0, 0, 0] },
    strength: { type: "float", value: 1, step: 0.5 },
    dt: DT_INPUT,
  },
  outputs: { velocity: { type: "vec3" } },
  params: {
    falloff: {
      kind: "structural",
      type: "enum",
      options: ["none", "linear", "inverse-square"],
      default: "inverse-square",
    },
  },
  // toCenter/distanceSquared/distance/coefficient/final ~21 flat; "none" skips the extra
  // falloff divide the linear/inverse-square modes spend.
  cost: ({ params }) => 21 + (params.falloff === "none" ? 0 : 2),
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, params, target, local, fn }) => {
    const position = target.read("PARTICLE_POSITION");
    const toCenter = local("pf_d", fn.sub(inputs["center"], position));
    const distanceSquared = local(
      "pf_dist2",
      fn.add(fn.call("dot", toCenter, toCenter), fn.lit(1e-6)),
    );
    const distance = local("pf_dist", fn.call("sqrt", distanceSquared));
    const falloff =
      params.falloff === "none"
        ? fn.lit(1)
        : params.falloff === "linear"
          ? fn.div(fn.lit(1), distance)
          : fn.div(fn.lit(1), distanceSquared);
    // coefficient folds direction normalization (1/distance), falloff and strength*dt.
    const coefficient = local(
      "pf_coef",
      fn.mul(fn.div(fn.mul(inputs["strength"], inputs["dt"]), distance), falloff),
    );
    return { velocity: fn.add(inputs["velocity"], fn.mul(toCenter, coefficient)) };
  },
});

/** Tangential swirl around an axis through a center, with optional inward pull. */
export const fxVortex = defineNode({
  type: "vortex",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    strength: { type: "float", value: 1, step: 0.5 },
    axis: { type: "vec3", value: [0, 1, 0] },
    center: { type: "vec3", value: [0, 0, 0] },
    inward: { type: "float", value: 0, step: 0.1 },
    dt: DT_INPUT,
  },
  outputs: { velocity: { type: "vec3" } },
  params: {},
  // Flat: offset subtract(3) + axis normalize (length(7)+guard(2)+divide(6)=15) + radial
  // projection (dot(5)+sub&mul(6)+length(7)+guard(2)+divide(6)=26) + cross-product tangent (9)
  // + the swirl blend (9) + final integrate (mul+add=6) = 68.
  cost: 68,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, target, local, fn }) => {
    const dt = inputs["dt"];
    const position = target.read("PARTICLE_POSITION");
    // offsetFromCenter = position - center; normalize axis (guarding a zero axis to length 1).
    const offsetFromCenter = local("vortex_r", fn.sub(position, inputs["center"]));
    const axisLength = local("vortex_al", fn.call("length", inputs["axis"]));
    const safeAxisLength = fn.select(fn.eq(axisLength, fn.lit(0)), fn.lit(1), axisLength);
    const unitAxis = local("vortex_na", fn.div(inputs["axis"], safeAxisLength));
    // Radial component of offsetFromCenter (perpendicular to the axis), normalized to a unit radius.
    const axialComponent = local("vortex_d", fn.call("dot", offsetFromCenter, unitAxis));
    const radial = local("vortex_rad", fn.sub(offsetFromCenter, fn.mul(unitAxis, axialComponent)));
    const radialLength = local("vortex_rl", fn.call("length", radial));
    const safeRadialLength = fn.select(fn.eq(radialLength, fn.lit(0)), fn.lit(1e-6), radialLength);
    const unitRadial = local("vortex_ur", fn.div(radial, safeRadialLength));
    // Tangent = axis x radial; swirl = tangent*strength - radial*inward.
    const tangent = local("vortex_t", cross(unitAxis, unitRadial, fn));
    const swirl = fn.sub(fn.mul(tangent, inputs["strength"]), fn.mul(unitRadial, inputs["inward"]));
    return { velocity: fn.add(inputs["velocity"], fn.mul(swirl, dt)) };
  },
});

/**
 * Instantaneous firework burst - a spawn-phase velocity *seeder* (no `dt`/`velocity` input): a
 * random direction in a cone of half-angle `angle` around `axis` (0 = axis, pi = full sphere),
 * scaled by `strength`. Built from an orthonormal basis, not `PARTICLE_POSITION` (zero pre-spawn);
 * the polar angle is sampled solid-angle-uniform over the cone cap, not a thin ring at `angle`.
 */
export const fxFirework = defineNode({
  type: "firework",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is inferred, not pinned.
  phaseFlexible: true,
  category: "spawn",
  inputs: {
    strength: { type: "float", value: 1, min: 0, step: 0.5 },
    axis: { type: "vec3", value: [0, 1, 0] },
    angle: { type: "float", value: 0.6, min: 0, max: Math.PI, step: 0.05 },
  },
  outputs: { velocity: { type: "vec3" } },
  params: {},
  // Flat: axis normalize (15) + helper select (5) + orthonormal basis (cross(9)+normalize(15)=24,
  // then a second cross(9)) + azimuth (rand+mul=3, then cos+sin+blend=17) + polar sampling
  // (mix=9, sqrt chain=5) + final direction blend (9) + strength scale (3) = 99.
  cost: 99,
  build: ({ inputs, local, fn }) => {
    // Normalize the axis, guarding a zero axis to length 1.
    const axisLength = local("fw_al", fn.call("length", inputs["axis"]));
    const safeAxisLength = fn.select(fn.eq(axisLength, fn.lit(0)), fn.lit(1), axisLength);
    const unitAxis = local("fw_na", fn.div(inputs["axis"], safeAxisLength));
    // Orthonormal tangent basis (tangentAxisA, tangentAxisB) perpendicular to `unitAxis`. Cross
    // with whichever world axis is least parallel to `unitAxis` (z unless `unitAxis` already
    // points near z) to avoid a near-zero cross product; tangentAxisA is normalized,
    // tangentAxisB = unitAxis x tangentAxisA is then already unit.
    const helper = fn.select(
      fn.lt(fn.call("abs", fn.swizzle(unitAxis, "z")), fn.lit(0.99)),
      fn.litVec(0, 0, 1),
      fn.litVec(1, 0, 0),
    );
    const tangentAxisA = local("fw_t1", fn.call("normalize", cross(unitAxis, helper, fn)));
    const tangentAxisB = local("fw_t2", cross(unitAxis, tangentAxisA, fn));
    // Random azimuth on the tangent plane -> a unit vector perpendicular to `unitAxis`.
    const phi = local("fw_phi", fn.mul(rand(fn), fn.lit(TWO_PI)));
    const perpendicular = local(
      "fw_perp",
      fn.add(fn.mul(tangentAxisA, fn.call("cos", phi)), fn.mul(tangentAxisB, fn.call("sin", phi))),
    );
    // Polar angle sampled so cos(theta) is uniform in [cos(angle), 1] - uniform over the
    // spherical cap (a real firework fills the cone, it isn't a thin ring at exactly `angle`).
    const cosTheta = local(
      "fw_cosT",
      fn.call("mix", fn.call("cos", inputs["angle"]), fn.lit(1), rand(fn)),
    );
    const sinTheta = local(
      "fw_sinT",
      fn.call("sqrt", fn.call("max", fn.lit(0), fn.sub(fn.lit(1), fn.mul(cosTheta, cosTheta)))),
    );
    // Unit burst direction on the cone, scaled to the burst speed.
    const direction = fn.add(fn.mul(unitAxis, cosTheta), fn.mul(perpendicular, sinTheta));
    return { velocity: fn.mul(direction, inputs["strength"]) };
  },
});

/** Fractal (fBm) velocity turbulence: three decorrelated fields sampled from the particle's full
 *  3D position (via `fbm3`), one per velocity channel - see TURBULENCE_CHANNEL_OFFSET. */
export const fxTurbulence = defineNode({
  type: "turbulence",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    amplitude: { type: "float", value: 1, min: 0, step: 0.1 },
    frequency: { type: "float", value: 1, min: 0, max: 40, step: 0.1 },
    octaves: { type: "float", value: 3, min: 0, max: FX_FBM_MAX_OCTAVES, step: 1 },
    time: { type: "float", default: { targetInput: "PARTICLE_AGE" } },
    dt: DT_INPUT,
  },
  outputs: { velocity: { type: "vec3" } },
  params: {},
  // `octaves` is an editable *input* pin (not a structural param), so its live value is not
  // available here - it can even be wired to an arbitrary sub-expression, not just a literal.
  // The compiled `fxFbm3` loop always runs up to FX_FBM_MAX_OCTAVES regardless (see its own
  // clamp), so that worst case is the honest static bound. Per octave: loop bookkeeping (5, same
  // shape as `fbm`'s) plus one 3D value-noise sample (184, see NOISE_CALL_COST[3] in
  // shared/noise.ts - `fbm3`'s private hash is the same shape as `noise`'s) = 189/octave, times 3
  // channels. Flat: the shared coordinate build (position*frequency + age = 6) + per channel
  // (decorrelation-offset add (3) + fxFbm3's own octave-count clamp (floor+max+min = 3)) times 3
  // channels (18) + the amplitude*dt kick (1) + the final vec3 blend (mul+add = 6) = 31.
  cost: 3 * FX_FBM_MAX_OCTAVES * 189 + 31,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, target, local, fn }) => {
    const age = inputs["time"];
    const position = target.read("PARTICLE_POSITION");
    const kick = local("turbKick", fn.mul(inputs["amplitude"], inputs["dt"]));
    // One shared coordinate for all three channels, so the whole field drifts together as `age`
    // advances instead of each channel animating along its own uncorrelated 1D axis.
    const coordinate = local(
      "turbCoordinate",
      fn.add(fn.mul(position, inputs["frequency"]), fn.coerceNumeric(age, VEC3)),
    );
    // fn.call("fbm3", ...): a normal registry function, tier-transparent (see the "fbm3" entry in
    // core/ir/FXFunctions.Internal.ts) - the active printer emits whichever helper it needs.
    const sample = (offset: readonly [number, number, number], hint: string): FXExpr =>
      local(hint, fn.call("fbm3", fn.add(coordinate, fn.litVec(...offset)), inputs["octaves"]));
    const noise = fn.construct(
      VEC3,
      sample(TURBULENCE_CHANNEL_OFFSET.x, "turbFieldX"),
      sample(TURBULENCE_CHANNEL_OFFSET.y, "turbFieldY"),
      sample(TURBULENCE_CHANNEL_OFFSET.z, "turbFieldZ"),
    );
    return { velocity: fn.add(inputs["velocity"], fn.mul(noise, kick)) };
  },
});

/** All standard behavior force node definitions. */
export const FX_BEHAVIOR_FORCE_NODES: readonly FXNodeDefinition[] = [
  fxGravity,
  fxDrag,
  fxPointForce,
  fxVortex,
  fxFirework,
  fxTurbulence,
];
