import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXExprBuilderApi, FXNodeDefinition } from "../../core/nodes/defineNode";
import { defineNode } from "../../core/nodes/defineNode";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import { VELOCITY_INPUT } from "./common";

/**
 * Standard-library collision behavior nodes (update phase). A collision node returns a corrected
 * velocity (the response) - wire it back to the velocity slot and let `integrate-motion` advance
 * position - and `contact`, 1 on a step the response applies and 0 otherwise, e.g. to wire into
 * the update sink's `kill`. `restitution`/`friction` are `saturate`d so a wired-in value stays in
 * `[0, 1]`.
 *
 * Every collider differs only in how it finds the contact - an outward unit normal and the signed
 * distance of the particle's center to the surface - and shares {@link bounce} for the response.
 */

const VEC2 = FX_VALUE_TYPES.vec2;

/**
 * The response every collider shares, given its contact: split the velocity into normal and
 * tangential parts, reflect the normal part by `-restitution` and damp the tangential part by
 * `1 - friction`. Applies only while the particle (a sphere of `radius`) overlaps the surface
 * (`signedDistance < radius`) *and* closes on it (moving against `unitNormal`), so a separating
 * particle doesn't jitter. `prefix` names the locals, one per node type.
 *
 * Cost: restitution/friction saturate (2) + normalVelocity dot (5) + the normal/tangent
 * split-and-reflect response (velocityNormal(3) + velocityTangent(3) + response(10) = 16) +
 * penetrating/approaching compares (2) + the nested vec3 select gating (6) + the contact mask's
 * nested scalar selects (2) = 33.
 */
function bounce(
  prefix: string,
  inputs: Readonly<Record<"velocity" | "radius" | "restitution" | "friction", FXExpr>>,
  contact: { readonly unitNormal: FXExpr; readonly signedDistance: FXExpr },
  local: (hint: string, expr: FXExpr) => FXExpr,
  fn: FXExprBuilderApi,
): { readonly velocity: FXExpr; readonly contact: FXExpr } {
  const velocity = inputs["velocity"];
  const restitution = fn.call("saturate", inputs["restitution"]);
  const friction = fn.call("saturate", inputs["friction"]);
  const normalVelocity = local(`${prefix}_vn`, fn.call("dot", velocity, contact.unitNormal));

  const velocityNormal = local(`${prefix}_vnorm`, fn.mul(contact.unitNormal, normalVelocity));
  const velocityTangent = fn.sub(velocity, velocityNormal);
  const response = local(
    `${prefix}_resp`,
    fn.sub(
      fn.mul(velocityTangent, fn.sub(fn.lit(1), friction)),
      fn.mul(velocityNormal, restitution),
    ),
  );

  const penetrating = fn.lt(contact.signedDistance, inputs["radius"]);
  const approaching = fn.lt(normalVelocity, fn.lit(0));
  return {
    velocity: fn.select(penetrating, fn.select(approaching, response, velocity), velocity),
    contact: fn.select(penetrating, fn.select(approaching, fn.lit(1), fn.lit(0)), fn.lit(0)),
  };
}

/** Bounce cost (see {@link bounce}) a collider's own contact cost is added to. */
const BOUNCE_COST = 33;

/** The outputs every collider shares (see {@link bounce}). */
const COLLIDER_OUTPUTS = { velocity: { type: "vec3" }, contact: { type: "float" } } as const;

/** `value`, or 1 where it is exactly 0: a divisor that keeps a degenerate direction finite. */
function nonZero(value: FXExpr, fn: FXExprBuilderApi): FXExpr {
  return fn.select(fn.eq(value, fn.lit(0)), fn.lit(1), value);
}

/**
 * Plane collision: a half-space collider (point + normal); the particle is a sphere of `radius`.
 * Responds only while penetrating *and* moving into the surface, so a separating particle doesn't jitter.
 */
export const fxPlaneCollision = defineNode({
  type: "plane-collision",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    // Particle center; defaults to the particle's own position but can be driven.
    position: { type: "vec3", default: { targetInput: "PARTICLE_POSITION" } },
    // Plane geometry.
    point: { type: "vec3", value: [0, 0, 0] },
    normal: { type: "vec3", value: [0, 1, 0] },
    // Collision physics.
    radius: { type: "float", value: 0.05, min: 0, step: 0.01 },
    restitution: { type: "float", value: 0.5, min: 0, max: 1, step: 0.05 },
    friction: { type: "float", value: 0, min: 0, max: 1, step: 0.05 },
  },
  outputs: COLLIDER_OUTPUTS,
  params: {},
  // Flat: normal normalize (length(7)+guard(2)+divide(6)=15) + signed distance (sub+dot=8) = 23,
  // plus the bounce.
  cost: 23 + BOUNCE_COST,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, local, fn }) => {
    // Normalize the plane normal, guarding a zero-length normal to unit length so the
    // signed-distance and projection math below stays finite for a degenerate input.
    const normalLength = local("pc_nlen", fn.call("length", inputs["normal"]));
    const safeNormalLength = nonZero(normalLength, fn);
    const unitNormal = local("pc_n", fn.div(inputs["normal"], safeNormalLength));

    // Signed distance of the center to the plane.
    const signedDistance = local(
      "pc_sd",
      fn.call("dot", fn.sub(inputs["position"], inputs["point"]), unitNormal),
    );
    return bounce("pc", inputs, { unitNormal, signedDistance }, local, fn);
  },
});

/**
 * Sphere collision: a solid sphere collider (`center` + `sphereRadius`); the particle is a
 * sphere of `radius`. Same penetrating+approaching gate as `plane-collision`, but the normal is
 * derived per-particle from the offset to the sphere center instead of a fixed input.
 */
export const fxSphereCollision = defineNode({
  type: "sphere-collision",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    // Particle center; defaults to the particle's own position but can be driven.
    position: { type: "vec3", default: { targetInput: "PARTICLE_POSITION" } },
    // Sphere geometry.
    center: { type: "vec3", value: [0, 0, 0] },
    sphereRadius: { type: "float", value: 1, min: 0, step: 0.01 },
    // Collision physics.
    radius: { type: "float", value: 0.05, min: 0, step: 0.01 },
    restitution: { type: "float", value: 0.5, min: 0, max: 1, step: 0.05 },
    friction: { type: "float", value: 0, min: 0, max: 1, step: 0.05 },
  },
  outputs: COLLIDER_OUTPUTS,
  params: {},
  // Flat: offset sub (3) + distance length (7) + zero-distance guard/select (2) + normal divide
  // (6) + fallback-normal select (6) + signed distance sub (1) = 25, plus the bounce.
  cost: 25 + BOUNCE_COST,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, local, fn }) => {
    // Offset from the sphere center to the particle, and its length; guard a particle sitting
    // exactly on the center (degenerate direction) with a fixed fallback normal.
    const offset = local("sc_off", fn.sub(inputs["position"], inputs["center"]));
    const distance = local("sc_dist", fn.call("length", offset));
    const safeDistance = nonZero(distance, fn);
    const unitNormal = local(
      "sc_n",
      fn.select(fn.eq(distance, fn.lit(0)), fn.litVec(0, 1, 0), fn.div(offset, safeDistance)),
    );

    // Signed distance to the sphere surface (negative once the particle center is inside the
    // sphere).
    const signedDistance = local("sc_sd", fn.sub(distance, inputs["sphereRadius"]));
    return bounce("sc", inputs, { unitNormal, signedDistance }, local, fn);
  },
});

/**
 * Box collision: an axis-aligned box collider (`center` + `halfExtents`); the particle is a
 * sphere of `radius`. The normal comes from the offset to the closest point on the box surface
 * (clamping the center-relative position into the box) - a rounded-box test against `radius`,
 * same shape as a sphere-vs-AABB check. That offset is exactly zero while the particle center is
 * inside the box, so (as with `sphere-collision`) a fixed fallback normal guards the degenerate
 * direction rather than resolving deep interior penetration.
 */
export const fxBoxCollision = defineNode({
  type: "box-collision",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    // Particle center; defaults to the particle's own position but can be driven.
    position: { type: "vec3", default: { targetInput: "PARTICLE_POSITION" } },
    // Box geometry.
    center: { type: "vec3", value: [0, 0, 0] },
    halfExtents: { type: "vec3", value: [0.5, 0.5, 0.5] },
    // Collision physics.
    radius: { type: "float", value: 0.05, min: 0, step: 0.01 },
    restitution: { type: "float", value: 0.5, min: 0, max: 1, step: 0.05 },
    friction: { type: "float", value: 0, min: 0, max: 1, step: 0.05 },
  },
  outputs: COLLIDER_OUTPUTS,
  params: {},
  // Flat: local offset sub (3) + per-axis clamp to the box (3) + surface offset sub (3) + distance
  // length (7) + zero-distance guard/select (2) + normal divide (6) + fallback-normal select (6) =
  // 30, plus the bounce.
  cost: 30 + BOUNCE_COST,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, local, fn }) => {
    // Closest point on the box surface to `position` (the center-relative offset clamped into
    // [-halfExtents, halfExtents]); `surfaceOffset` is the vector from that point back to
    // `position`, and is exactly zero while `position` is inside the box.
    const localPosition = local("bc_local", fn.sub(inputs["position"], inputs["center"]));
    const clampedLocal = local(
      "bc_clamped",
      fn.call("clamp", localPosition, fn.neg(inputs["halfExtents"]), inputs["halfExtents"]),
    );
    const surfaceOffset = local("bc_off", fn.sub(localPosition, clampedLocal));
    const distance = local("bc_dist", fn.call("length", surfaceOffset));
    const safeDistance = nonZero(distance, fn);
    const unitNormal = local(
      "bc_n",
      fn.select(
        fn.eq(distance, fn.lit(0)),
        fn.litVec(0, 1, 0),
        fn.div(surfaceOffset, safeDistance),
      ),
    );
    // `distance` already folds in the box's own half-extents (via the clamp), so it doubles as
    // the signed distance to the surface.
    return bounce("bc", inputs, { unitNormal, signedDistance: distance }, local, fn);
  },
});

/**
 * Cone collision: a solid truncated cone (frustum) about an arbitrary `axis`; the particle is a
 * sphere of `radius`. Its base, of `bottomRadius`, is centered on `center`; its top, of
 * `topRadius`, sits `height` along the axis - the same base-anchored layout as `spawn-cone`.
 * `topRadius` 0 makes it a plain cone, `topRadius == bottomRadius` a cylinder.
 *
 * The shape is round about its axis, so the contact is found in the 2D half-plane through the axis
 * and the particle: `(r, h)` = distance from the axis and height along it, where the solid is a
 * trapezoid bounded by the bottom cap, the top cap and the slanted side. The closest of the three
 * edges gives the contact point; the offset to it, turned back into 3D, gives the normal. Unlike
 * `box-collision`, a particle inside the solid is pushed out through the nearest surface (a
 * negative signed distance, the offset's direction flipped), not by a fixed fallback normal.
 */
export const fxConeCollision = defineNode({
  type: "cone-collision",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    // Particle center; defaults to the particle's own position but can be driven.
    position: { type: "vec3", default: { targetInput: "PARTICLE_POSITION" } },
    // Cone geometry.
    center: { type: "vec3", value: [0, 0, 0] },
    axis: { type: "vec3", value: [0, 1, 0] },
    height: { type: "float", value: 1, min: 0, step: 0.1 },
    bottomRadius: { type: "float", value: 1, min: 0, step: 0.1 },
    topRadius: { type: "float", value: 0.5, min: 0, step: 0.1 },
    // Collision physics.
    radius: { type: "float", value: 0.05, min: 0, step: 0.01 },
    restitution: { type: "float", value: 0.5, min: 0, max: 1, step: 0.05 },
    friction: { type: "float", value: 0, min: 0, max: 1, step: 0.05 },
  },
  outputs: COLLIDER_OUTPUTS,
  params: {},
  // Flat: the cone's frame - dimension clamps (3) + axis normalize with a +Y fallback (15+6=21)
  // + axial split (offset(3)+dot(5)+radial sub/mul(6)+length(7)+guard(2)+divide(6)=29) + the
  // on-axis radial fallback (abs+compare(2)+select(5)+dot(5)+sub/mul(6)+normalize(15)+select(6)=
  // 39) = 92; the 2D contact - caps (clamp+sub+length = 8 each, 16) + side (edge/lengthSq/guard
  // (6)+projection(7)+point(4)+distance(7)=24) + closest of three (8) + inside test (cross(3)+
  // compares(3)+products(2)=8) + sign and signed distance (2) + normal with fallback (9) + back
  // to 3D (9) = 76; 92 + 76 = 168, plus the bounce.
  cost: 168 + BOUNCE_COST,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, local, fn }) => {
    // A wired-in negative dimension would turn the trapezoid inside out; clamp them all to 0.
    const height = local("cc_h", fn.call("max", inputs["height"], fn.lit(0)));
    const bottomRadius = local("cc_r0", fn.call("max", inputs["bottomRadius"], fn.lit(0)));
    const topRadius = local("cc_r1", fn.call("max", inputs["topRadius"], fn.lit(0)));

    // Unit axis; a zero-length one falls back to +Y, so the cone still has a frame.
    const axisLength = local("cc_alen", fn.call("length", inputs["axis"]));
    const axisUnit = local(
      "cc_a",
      fn.select(
        fn.eq(axisLength, fn.lit(0)),
        fn.litVec(0, 1, 0),
        fn.div(inputs["axis"], nonZero(axisLength, fn)),
      ),
    );

    // The particle in the cone's own frame: height along the axis, and the radial offset from it.
    const localPosition = local("cc_local", fn.sub(inputs["position"], inputs["center"]));
    const axial = local("cc_axial", fn.call("dot", localPosition, axisUnit));
    const radialOffset = local("cc_roff", fn.sub(localPosition, fn.mul(axisUnit, axial)));
    const radial = local("cc_radial", fn.call("length", radialOffset));
    // Right on the axis every radial direction is as good as any other; pick one perpendicular to
    // the axis from a world axis it is never close to parallel with, so the result stays finite.
    const helperAxis = fn.select(
      fn.lt(fn.call("abs", fn.swizzle(axisUnit, "z")), fn.lit(0.999)),
      fn.litVec(0, 0, 1),
      fn.litVec(1, 0, 0),
    );
    const onAxisRadial = fn.call(
      "normalize",
      fn.sub(helperAxis, fn.mul(axisUnit, fn.call("dot", helperAxis, axisUnit))),
    );
    const radialUnit = local(
      "cc_ru",
      fn.select(fn.eq(radial, fn.lit(0)), onAxisRadial, fn.div(radialOffset, nonZero(radial, fn))),
    );

    // The 2D contact. `point` is the particle as (r, h); the solid spans h in [0, height] and
    // r in [0, R(h)], R running linearly from bottomRadius to topRadius.
    const point = local("cc_p", fn.construct(VEC2, radial, axial));
    const bottomClosest = fn.construct(
      VEC2,
      fn.call("clamp", radial, fn.lit(0), bottomRadius),
      fn.lit(0),
    );
    const topClosest = fn.construct(VEC2, fn.call("clamp", radial, fn.lit(0), topRadius), height);
    const sideStart = local("cc_s0", fn.construct(VEC2, bottomRadius, fn.lit(0)));
    const sideEdge = local("cc_se", fn.construct(VEC2, fn.sub(topRadius, bottomRadius), height));
    const sideLengthSquared = local("cc_sl2", fn.call("dot", sideEdge, sideEdge));
    const fromSideStart = local("cc_ps", fn.sub(point, sideStart));
    const sideFraction = fn.call(
      "clamp",
      fn.div(fn.call("dot", fromSideStart, sideEdge), nonZero(sideLengthSquared, fn)),
      fn.lit(0),
      fn.lit(1),
    );
    const sideClosest = local("cc_qs", fn.add(sideStart, fn.mul(sideEdge, sideFraction)));
    const bottomDistance = local("cc_db", fn.call("length", fn.sub(point, bottomClosest)));
    const topDistance = local("cc_dt", fn.call("length", fn.sub(point, topClosest)));
    const sideDistance = local("cc_ds", fn.call("length", fn.sub(point, sideClosest)));

    const capClosest = fn.select(fn.lt(topDistance, bottomDistance), topClosest, bottomClosest);
    const capDistance = local("cc_dc", fn.call("min", topDistance, bottomDistance));
    const closest = fn.select(fn.lt(sideDistance, capDistance), sideClosest, capClosest);
    const distance = local("cc_dist", fn.call("min", sideDistance, capDistance));
    // From the surface to the particle: outward while outside, inward while inside.
    const surfaceOffset = local("cc_off", fn.sub(point, closest));

    // Inside: between the caps and on the axis's side of the slanted edge (the 2D cross product
    // of the edge and the offset from its start is non-negative there - no division by height).
    const besideSide = fn.ge(
      fn.sub(
        fn.mul(fn.swizzle(sideEdge, "x"), fn.swizzle(fromSideStart, "y")),
        fn.mul(fn.swizzle(sideEdge, "y"), fn.swizzle(fromSideStart, "x")),
      ),
      fn.lit(0),
    );
    const inside = fn.mul(fn.mul(fn.ge(axial, fn.lit(0)), fn.le(axial, height)), besideSide);
    const outwardSign = local("cc_sign", fn.select(inside, fn.lit(-1), fn.lit(1)));
    const signedDistance = local("cc_sd", fn.mul(distance, outwardSign));

    // The outward 2D normal (exactly on the surface it has no direction: fall back to +axis), then
    // back to 3D along the radial direction and the axis.
    const normal2D = local(
      "cc_n2",
      fn.select(
        fn.eq(distance, fn.lit(0)),
        fn.litVec(0, 1),
        fn.mul(fn.div(surfaceOffset, nonZero(distance, fn)), outwardSign),
      ),
    );
    const unitNormal = local(
      "cc_n",
      fn.add(
        fn.mul(radialUnit, fn.swizzle(normal2D, "x")),
        fn.mul(axisUnit, fn.swizzle(normal2D, "y")),
      ),
    );
    return bounce("cc", inputs, { unitNormal, signedDistance }, local, fn);
  },
});

/** All standard collision behavior node definitions. */
export const FX_BEHAVIOR_COLLISION_NODES: readonly FXNodeDefinition[] = [
  fxPlaneCollision,
  fxSphereCollision,
  fxBoxCollision,
  fxConeCollision,
];
