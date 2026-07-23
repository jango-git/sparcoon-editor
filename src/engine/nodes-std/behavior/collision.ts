import { defineNode } from "../../core/nodes/defineNode";
import type { FXNodeDefinition } from "../../core/nodes/defineNode";
import { VELOCITY_INPUT } from "./common";

/**
 * Standard-library collision behavior nodes (update phase). A collision node returns only a
 * corrected velocity (the response); wire it back to the velocity slot and let `integrate-motion`
 * advance position. `restitution`/`friction` are `saturate`d so a wired-in value stays in `[0, 1]`.
 */

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
  outputs: { velocity: { type: "vec3" } },
  params: {},
  // Flat: restitution/friction saturate (2) + normal normalize (length(7)+guard(2)+divide(6)=15)
  // + signed distance (sub+dot=8) + normalVelocity dot (5) + the normal/tangent split-and-reflect
  // response (velocityNormal(3)+velocityTangent(3)+response(10)=16) + penetrating/approaching
  // compares (2) + the nested vec3 select gating (6) = 54.
  cost: 54,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, local, fn }) => {
    const velocity = inputs["velocity"];
    const restitution = fn.call("saturate", inputs["restitution"]);
    const friction = fn.call("saturate", inputs["friction"]);

    // Normalize the plane normal, guarding a zero-length normal to unit length so the
    // signed-distance and projection math below stays finite for a degenerate input.
    const normalLength = local("pc_nlen", fn.call("length", inputs["normal"]));
    const safeNormalLength = fn.select(fn.eq(normalLength, fn.lit(0)), fn.lit(1), normalLength);
    const unitNormal = local("pc_n", fn.div(inputs["normal"], safeNormalLength));

    // Signed distance of the center to the plane, and the velocity's normal component.
    const signedDistance = local(
      "pc_sd",
      fn.call("dot", fn.sub(inputs["position"], inputs["point"]), unitNormal),
    );
    const normalVelocity = local("pc_vn", fn.call("dot", velocity, unitNormal));

    // Split velocity into normal (normalVelocity*unitNormal) and tangential parts, then
    // reflect the normal part by -restitution and damp the tangential part by (1 - friction).
    const velocityNormal = local("pc_vnorm", fn.mul(unitNormal, normalVelocity));
    const velocityTangent = fn.sub(velocity, velocityNormal);
    const response = local(
      "pc_resp",
      fn.sub(
        fn.mul(velocityTangent, fn.sub(fn.lit(1), friction)),
        fn.mul(velocityNormal, restitution),
      ),
    );

    // Respond only when the sphere overlaps the plane (signedDistance < radius) *and* is
    // closing on it (normalVelocity < 0, i.e. moving along -normal); otherwise pass the
    // velocity through unchanged.
    const penetrating = fn.lt(signedDistance, inputs["radius"]);
    const approaching = fn.lt(normalVelocity, fn.lit(0));
    return {
      velocity: fn.select(penetrating, fn.select(approaching, response, velocity), velocity),
    };
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
  outputs: { velocity: { type: "vec3" } },
  params: {},
  // Flat: restitution/friction saturate (2) + offset sub (3) + distance length (7) + zero-distance
  // guard/select (2) + normal divide (6) + fallback-normal select (6) + signed distance sub (1) +
  // normalVelocity dot (5) + the normal/tangent split-and-reflect response (velocityNormal(3)+
  // velocityTangent(3)+response(10)=16) + penetrating/approaching compares (2) + the nested vec3
  // select gating (6) = 56.
  cost: 56,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, local, fn }) => {
    const velocity = inputs["velocity"];
    const restitution = fn.call("saturate", inputs["restitution"]);
    const friction = fn.call("saturate", inputs["friction"]);

    // Offset from the sphere center to the particle, and its length; guard a particle sitting
    // exactly on the center (degenerate direction) with a fixed fallback normal.
    const offset = local("sc_off", fn.sub(inputs["position"], inputs["center"]));
    const distance = local("sc_dist", fn.call("length", offset));
    const safeDistance = fn.select(fn.eq(distance, fn.lit(0)), fn.lit(1), distance);
    const unitNormal = local(
      "sc_n",
      fn.select(fn.eq(distance, fn.lit(0)), fn.litVec(0, 1, 0), fn.div(offset, safeDistance)),
    );

    // Signed distance to the sphere surface (negative once the particle center is inside the
    // sphere), and the velocity's normal component.
    const signedDistance = local("sc_sd", fn.sub(distance, inputs["sphereRadius"]));
    const normalVelocity = local("sc_vn", fn.call("dot", velocity, unitNormal));

    // Same normal/tangent split-and-reflect response as plane-collision.
    const velocityNormal = local("sc_vnorm", fn.mul(unitNormal, normalVelocity));
    const velocityTangent = fn.sub(velocity, velocityNormal);
    const response = local(
      "sc_resp",
      fn.sub(
        fn.mul(velocityTangent, fn.sub(fn.lit(1), friction)),
        fn.mul(velocityNormal, restitution),
      ),
    );

    const penetrating = fn.lt(signedDistance, inputs["radius"]);
    const approaching = fn.lt(normalVelocity, fn.lit(0));
    return {
      velocity: fn.select(penetrating, fn.select(approaching, response, velocity), velocity),
    };
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
  outputs: { velocity: { type: "vec3" } },
  params: {},
  // Flat: restitution/friction saturate (2) + local offset sub (3) + per-axis clamp to the box
  // (3) + surface offset sub (3) + distance length (7) + zero-distance guard/select (2) + normal
  // divide (6) + fallback-normal select (6) + normalVelocity dot (5) + the normal/tangent
  // split-and-reflect response (velocityNormal(3)+velocityTangent(3)+response(10)=16) +
  // penetrating/approaching compares (2) + the nested vec3 select gating (6) = 61.
  cost: 61,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, local, fn }) => {
    const velocity = inputs["velocity"];
    const restitution = fn.call("saturate", inputs["restitution"]);
    const friction = fn.call("saturate", inputs["friction"]);

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
    const safeDistance = fn.select(fn.eq(distance, fn.lit(0)), fn.lit(1), distance);
    const unitNormal = local(
      "bc_n",
      fn.select(
        fn.eq(distance, fn.lit(0)),
        fn.litVec(0, 1, 0),
        fn.div(surfaceOffset, safeDistance),
      ),
    );
    const normalVelocity = local("bc_vn", fn.call("dot", velocity, unitNormal));

    // Same normal/tangent split-and-reflect response as plane-collision.
    const velocityNormal = local("bc_vnorm", fn.mul(unitNormal, normalVelocity));
    const velocityTangent = fn.sub(velocity, velocityNormal);
    const response = local(
      "bc_resp",
      fn.sub(
        fn.mul(velocityTangent, fn.sub(fn.lit(1), friction)),
        fn.mul(velocityNormal, restitution),
      ),
    );

    // `distance` already folds in the box's own half-extents (via the clamp), so it doubles as
    // the signed-distance-to-surface used by plane/sphere collision.
    const penetrating = fn.lt(distance, inputs["radius"]);
    const approaching = fn.lt(normalVelocity, fn.lit(0));
    return {
      velocity: fn.select(penetrating, fn.select(approaching, response, velocity), velocity),
    };
  },
});

/** All standard collision behavior node definitions. */
export const FX_BEHAVIOR_COLLISION_NODES: readonly FXNodeDefinition[] = [
  fxPlaneCollision,
  fxSphereCollision,
  fxBoxCollision,
];
