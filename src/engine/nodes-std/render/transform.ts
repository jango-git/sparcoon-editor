import { defineNode } from "../../core/nodes/defineNode";
import type { FXExprBuilderApi, FXNodeDefinition } from "../../core/nodes/defineNode";
import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXParamSpec } from "../../core/nodes/FXParamSpec";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import * as fx from "../../core/ir/FXExprBuilder";
import {
  CAMERA_MODEL_PARAM,
  cameraDirectionForModel,
  cameraModelReads,
  orthogonalTowardTarget,
} from "./cameraSupport.Internal";

/**
 * Standard-library transform nodes: producers of the two `mat4` render output slots
 * (`particleTransform` / `vertexTransform`). A billboard is not a special case - it is a plane
 * mesh whose `particleTransform` is fed a camera-facing rotation from {@link fxLookAtCamera}.
 */

const VEC4 = FX_VALUE_TYPES.vec4;
const MAT3 = FX_VALUE_TYPES.mat3;
const MAT4 = FX_VALUE_TYPES.mat4;

/** The identity `mat3`, the unwired default of {@link fxComposeTransform}'s rotation input. */
const IDENTITY_MAT3 = fx.construct(
  MAT3,
  fx.litVec(1, 0, 0),
  fx.litVec(0, 1, 0),
  fx.litVec(0, 0, 1),
);

/**
 * The `axis` structural param of {@link fxLookAtCamera}. `"all"` faces the camera fully (the
 * plain billboard, unconstrained). `"x"/"y"/"z"` locks that local axis to its own world
 * direction and only rotates the other two to face the camera - a cylindrical billboard, e.g.
 * grass/trees keep their up axis vertical instead of tilting toward the camera.
 */
const LOOK_AT_AXIS_PARAM = {
  kind: "structural",
  type: "enum",
  options: ["all", "x", "y", "z"],
  default: "all",
} as const satisfies FXParamSpec;

/** The world-space unit vector for a locked axis choice ("all" never reaches this). */
function lockedAxisVector(axis: string, fn: FXExprBuilderApi): FXExpr {
  switch (axis) {
    case "x":
      return fn.litVec(1, 0, 0);
    case "y":
      return fn.litVec(0, 1, 0);
    default: // "z"
      return fn.litVec(0, 0, 1);
  }
}

/**
 * Camera-facing rotation (`mat3`) that turns a mesh's local axes to face the camera - the
 * billboard, expressed as a node. `"all"` recovers the camera's world-space right/up/forward
 * directly from the view matrix as `transpose(mat3(viewMatrix)) * e_i` (the IR has no
 * matrix-indexing operator) - unaffected by `cameraModel`, since it has no fixed axis to build a
 * per-particle camera direction against. A locked axis instead builds its camera-facing axis
 * through {@link orthogonalTowardTarget} against `cameraModel`'s direction (see
 * {@link cameraDirectionForModel}). `roll` spins the sprite about the locked axis (`"all"`: about
 * the unchanged `forward`).
 */
export const fxLookAtCamera = defineNode({
  type: "look-at-camera",
  domain: "render",
  stage: "param",
  category: "matrix",
  inputs: {
    roll: { type: "float", value: 0, step: 0.05 },
    // The "point" camera model only: where this particle actually renders. Unconnected -> the raw
    // simulated PARTICLE_POSITION; override when the graph renders it somewhere else (e.g.
    // attached to the emitter via fxTransformPoint(fxWorldMatrix, ...)), or the camera direction
    // is wrong. Deliberately `required: false` with no `targetInput` default (see
    // cameraDirectionForModel) so "all"/locked-axis+parallel stay legal on a target without
    // PARTICLE_POSITION, e.g. a VFX mesh.
    position: { type: "vec3", required: false },
  },
  outputs: { out: { type: "mat3" } },
  params: { axis: LOOK_AT_AXIS_PARAM, cameraModel: CAMERA_MODEL_PARAM },
  // "all": transpose (0) + 3 mat3*vec3 basis transforms (45) + cos/sin (8) + two roll-blend
  // terms, each a per-component vec3 mul+mul+add (9 each = 18) = 71 (cameraModel has no effect
  // here, see the doc comment above).
  // Locked axis: camera direction (parallel: transpose(0) + mat3*vec3(15) = 15; point: sub(3) +
  // normalize(15) = 18) + cos/sin (8) + orthogonalTowardTarget (67, see align-to-velocity's cost
  // comment for the breakdown) + 1 cross product (9) + two roll-blend terms (18) = 117 (parallel)
  // / 120 (point).
  cost: ({ params }) =>
    params.axis === "all" ? 71 : 8 + (params.cameraModel === "point" ? 18 : 15) + 67 + 9 + 18,
  reads: (params) =>
    params["axis"] === "all" ? ["viewMatrix"] : cameraModelReads(params["cameraModel"]),
  build: ({ inputs, params, target, local, fn }) => {
    const cosineRoll = local("lac_c", fn.call("cos", inputs["roll"]));
    const sineRoll = local("lac_s", fn.call("sin", inputs["roll"]));

    if (params.axis === "all") {
      // view->world rotation: its columns are the camera basis expressed in world space.
      const toWorld = local(
        "lac_tw",
        fn.call("transpose", fn.construct(MAT3, target.read("viewMatrix"))),
      );
      const cameraForward = local("lac_f", fn.mul(toWorld, fn.litVec(0, 0, 1)));
      const right = local("lac_r", fn.mul(toWorld, fn.litVec(1, 0, 0)));
      const up = local("lac_u", fn.mul(toWorld, fn.litVec(0, 1, 0)));
      // Roll: rotate right/up within the view plane, forward is the roll axis (unchanged).
      const rolledRight = fn.add(fn.mul(right, cosineRoll), fn.mul(up, sineRoll));
      const rolledUp = fn.sub(fn.mul(up, cosineRoll), fn.mul(right, sineRoll));
      return { out: fn.construct(MAT3, rolledRight, rolledUp, cameraForward) };
    }

    // Axis-locked (cylindrical) billboard: the chosen axis stays pinned to its own world
    // direction; `reference` turns as close to the camera direction as it can while staying
    // orthogonal to that fixed axis, so the free basis rotates around the locked axis to face
    // the camera as closely as it can.
    const fixedAxis = lockedAxisVector(params.axis, fn);
    const cameraDirection = cameraDirectionForModel(
      params.cameraModel,
      inputs["position"],
      target,
      local,
      fn,
    );
    const reference = local("lac_d", orthogonalTowardTarget(fixedAxis, cameraDirection, local, fn));

    if (params.axis === "x") {
      const up = local("lac_u", fn.call("cross", reference, fixedAxis));
      // Roll: rotate up/forward within the plane perpendicular to the locked right axis.
      const rolledUp = fn.add(fn.mul(up, cosineRoll), fn.mul(reference, sineRoll));
      const rolledForward = fn.sub(fn.mul(reference, cosineRoll), fn.mul(up, sineRoll));
      return { out: fn.construct(MAT3, fixedAxis, rolledUp, rolledForward) };
    }

    if (params.axis === "y") {
      const right = local("lac_r", fn.call("cross", fixedAxis, reference));
      // Roll: rotate forward/right within the plane perpendicular to the locked up axis.
      const rolledForward = fn.add(fn.mul(reference, cosineRoll), fn.mul(right, sineRoll));
      const rolledRight = fn.sub(fn.mul(right, cosineRoll), fn.mul(reference, sineRoll));
      return { out: fn.construct(MAT3, rolledRight, fixedAxis, rolledForward) };
    }

    // "z": the locked axis is `forward` itself, so `reference` (facing the camera as closely as
    // a fixed forward allows) becomes `up`, matching how a ground decal yaws toward the camera.
    const right = local("lac_r", fn.call("cross", reference, fixedAxis));
    const rolledRight = fn.add(fn.mul(right, cosineRoll), fn.mul(reference, sineRoll));
    const rolledUp = fn.sub(fn.mul(reference, cosineRoll), fn.mul(right, sineRoll));
    return { out: fn.construct(MAT3, rolledRight, rolledUp, fixedAxis) };
  },
});

/**
 * Assembles a position/rotation/scale `mat4` (`T * R * S`, column-major) for a transform slot -
 * the ergonomic driver: wire `look-at-camera` (or any `mat3`) into `rotation`, set position/scale
 * inline, or leave them at identity.
 */
export const fxComposeTransform = defineNode({
  type: "compose-transform",
  domain: "render",
  stage: "param",
  category: "matrix",
  inputs: {
    position: { type: "vec3", value: [0, 0, 0], step: 0.05 },
    rotation: { type: "mat3", default: IDENTITY_MAT3 },
    scale: { type: "vec3", value: [1, 1, 1], step: 0.05 },
  },
  outputs: { out: { type: "mat4" } },
  params: {},
  // scaleM/rotM/translateM assembly is a data reshuffle (0); T*R*S is 2 mat4*mat4
  // multiplies (64 multiplies + 48 adds each).
  cost: 224,
  build: ({ inputs, local, fn }) => {
    const zero = fn.lit(0);
    const one = fn.lit(1);
    const scaleX = fn.swizzle(inputs["scale"], "x");
    const scaleY = fn.swizzle(inputs["scale"], "y");
    const scaleZ = fn.swizzle(inputs["scale"], "z");
    const scaleMatrix = local(
      "ct_s",
      fn.construct(
        MAT4,
        fn.construct(VEC4, scaleX, zero, zero, zero),
        fn.construct(VEC4, zero, scaleY, zero, zero),
        fn.construct(VEC4, zero, zero, scaleZ, zero),
        fn.litVec(0, 0, 0, 1),
      ),
    );
    // mat4(mat3) extends the rotation with an identity 4th row/column (no translation/skew).
    const rotationMatrix = local("ct_r", fn.construct(MAT4, inputs["rotation"]));
    const translationMatrix = local(
      "ct_t",
      fn.construct(
        MAT4,
        fn.litVec(1, 0, 0, 0),
        fn.litVec(0, 1, 0, 0),
        fn.litVec(0, 0, 1, 0),
        fn.construct(VEC4, inputs["position"], one),
      ),
    );
    return { out: fn.mul(fn.mul(translationMatrix, rotationMatrix), scaleMatrix) };
  },
});

/** All standard render transform node definitions. */
export const FX_RENDER_TRANSFORM_NODES: readonly FXNodeDefinition[] = [
  fxLookAtCamera,
  fxComposeTransform,
];
