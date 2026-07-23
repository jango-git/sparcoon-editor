import { defineNode } from "../../core/nodes/defineNode";
import type { FXNodeDefinition, FXExprBuilderApi } from "../../core/nodes/defineNode";
import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXParamSpec } from "../../core/nodes/FXParamSpec";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import { rand, TWO_PI } from "./common";

/**
 * Standard-library behavior spawn nodes (spawn phase): each seeds initial state at birth via
 * inline `Math.random()`; a value meant to persist across frames must be stored into a `seed`
 * attribute (`Math.random()` in a later phase re-randomizes every frame). The axis-based shapes
 * (cylinder/cone/torus/disc) sample a local `(inPlaneA, inPlaneB, axisOffset)` frame folded by
 * {@link orient}.
 */

const VEC3 = FX_VALUE_TYPES.vec3;

/** `mix(range.x, range.y, random)` - a random draw across a `[min, max]` vec2 range. */
function sampleRange(range: FXExpr, random: FXExpr, fn: FXExprBuilderApi): FXExpr {
  return fn.call("mix", fn.swizzle(range, "x"), fn.swizzle(range, "y"), random);
}

/**
 * The `axis` structural param shared by the swept shapes (cylinder/cone/torus/disc): which local
 * axis is the shape's symmetry axis. Defaults to `y` (matches an up-oriented emitter).
 */
const AXIS_PARAM = {
  kind: "structural",
  type: "enum",
  options: ["x", "y", "z"],
  default: "y",
} as const satisfies FXParamSpec;

/** The `Surface Only` structural flag shared by shapes that switch volume <-> surface. */
const SURFACE_PARAM = {
  kind: "structural",
  type: "flag",
  default: false,
} as const satisfies FXParamSpec;

/**
 * Folds a local `(inPlaneA, inPlaneB, axisOffset)` sample into a vec3 for the chosen `axis`.
 * `axis` is a compile-time structural string, so this is a plain build-time branch (no runtime
 * selection).
 */
function orient(
  axis: string,
  inPlaneA: FXExpr,
  inPlaneB: FXExpr,
  axisOffset: FXExpr,
  fn: FXExprBuilderApi,
): FXExpr {
  switch (axis) {
    case "x":
      return fn.construct(VEC3, axisOffset, inPlaneA, inPlaneB);
    case "z":
      return fn.construct(VEC3, inPlaneA, inPlaneB, axisOffset);
    default: // "y"
      return fn.construct(VEC3, inPlaneA, axisOffset, inPlaneB);
  }
}

/** Random lifetime in seconds, `lifetime = mix(min, max, random)`. */
export const fxLifetime = defineNode({
  type: "lifetime",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is inferred, not pinned.
  phaseFlexible: true,
  category: "spawn",
  inputs: {
    min: { type: "float", value: 1, min: 0, step: 0.1 },
    max: { type: "float", value: 1, min: 0, step: 0.1 },
  },
  outputs: { value: { type: "float" } },
  params: {},
  // A random draw (~2) + a scalar mix (~3).
  cost: 5,
  build: ({ inputs, fn }) => ({
    value: fn.call("mix", inputs["min"], inputs["max"], rand(fn)),
  }),
});

/** Scatters particles uniformly inside an axis-aligned box, or over its surface. */
export const fxSpawnBox = defineNode({
  type: "spawn-box",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is inferred, not pinned.
  phaseFlexible: true,
  category: "spawn",
  inputs: {
    size: { type: "vec3", value: [1, 1, 1] },
    center: { type: "vec3", value: [0, 0, 0] },
  },
  outputs: { position: { type: "vec3" } },
  params: { surfaceOnly: SURFACE_PARAM },
  // Volume: 3 independent per-axis draws (~5 each). Surface: face-area weighting (areaX+areaY+
  // total=6) + branchless face selectors (faceSelector(2)+selectX(3)+selectZ(5)+selectY(2)=12) +
  // signHalf/offsetA/offsetB draws (11) + the x/y/z component blends (16) + the final center
  // add (3) = 48.
  cost: ({ params }) => (params.surfaceOnly === true ? 48 : 15),
  build: ({ inputs, params, local, fn }) => {
    const size = inputs["size"];
    const center = inputs["center"];
    if (!params.surfaceOnly) {
      // center_i + (random_i - 0.5) * size_i; three independent draws.
      const axis = (channel: string): FXExpr =>
        fn.add(
          fn.swizzle(center, channel),
          fn.mul(fn.sub(rand(fn), fn.lit(0.5)), fn.swizzle(size, channel)),
        );
      return { position: fn.construct(VEC3, axis("x"), axis("y"), axis("z")) };
    }
    // Surface: pick one of the six faces weighted by area (uniform over the whole surface,
    // not per-face), then a uniform point on it. `select*` are branchless 0/1 face indicators.
    const sizeX = local("bx_sx", fn.swizzle(size, "x"));
    const sizeY = local("bx_sy", fn.swizzle(size, "y"));
    const sizeZ = local("bx_sz", fn.swizzle(size, "z"));
    const areaX = fn.mul(sizeY, sizeZ);
    const areaY = fn.mul(sizeX, sizeZ);
    const total = local(
      "bx_total",
      fn.add(fn.add(areaX, areaY), fn.add(fn.mul(sizeX, sizeY), fn.lit(1e-6))),
    );
    const faceSelector = local("bx_u", rand(fn));
    const selectX = local("bx_selX", fn.lt(faceSelector, fn.div(areaX, total)));
    const selectZ = local(
      "bx_selZ",
      fn.sub(fn.lit(1), fn.lt(faceSelector, fn.div(fn.add(areaX, areaY), total))),
    );
    const selectY = local("bx_selY", fn.sub(fn.sub(fn.lit(1), selectX), selectZ));
    // sign*0.5 snaps the active axis to a +/- face; offsetA/offsetB are the two in-plane offsets.
    const signHalf = local(
      "bx_sgnHalf",
      fn.mul(fn.call("sign", fn.sub(rand(fn), fn.lit(0.5))), fn.lit(0.5)),
    );
    const offsetA = local("bx_ra", fn.sub(rand(fn), fn.lit(0.5)));
    const offsetB = local("bx_rb", fn.sub(rand(fn), fn.lit(0.5)));
    const xComponent = fn.mul(
      sizeX,
      fn.add(fn.mul(selectX, signHalf), fn.mul(fn.add(selectY, selectZ), offsetA)),
    );
    const yComponent = fn.mul(
      sizeY,
      fn.add(fn.add(fn.mul(selectX, offsetA), fn.mul(selectY, signHalf)), fn.mul(selectZ, offsetB)),
    );
    const zComponent = fn.mul(
      sizeZ,
      fn.add(fn.mul(fn.add(selectX, selectY), offsetB), fn.mul(selectZ, signHalf)),
    );
    return { position: fn.add(center, fn.construct(VEC3, xComponent, yComponent, zComponent)) };
  },
});

/** Scatters particles inside (or on the surface of) a sphere, uniformly. */
export const fxSpawnSphere = defineNode({
  type: "spawn-sphere",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is inferred, not pinned.
  phaseFlexible: true,
  category: "spawn",
  inputs: {
    radius: { type: "float", value: 1, min: 0, step: 0.1 },
    center: { type: "vec3", value: [0, 0, 0] },
  },
  outputs: { position: { type: "vec3" } },
  params: { surfaceOnly: SURFACE_PARAM },
  // theta(3)+height(4)+ringRadius(5)=12, plus the final vec3 assembly (cos/sin transcendentals
  // included: 7+7+2=16) = 28. Volume mode adds an independent rand+cbrt+scale draw (5).
  cost: ({ params }) => 28 + (params.surfaceOnly === true ? 0 : 5),
  build: ({ inputs, params, local, fn }) => {
    // Uniform direction on the sphere: azimuth theta, height, ring radius ringRadius.
    const theta = local("theta", fn.mul(rand(fn), fn.lit(TWO_PI)));
    const height = local("zc", fn.sub(fn.mul(rand(fn), fn.lit(2)), fn.lit(1)));
    const ringRadius = local(
      "rxy",
      fn.call("sqrt", fn.call("max", fn.lit(0), fn.sub(fn.lit(1), fn.mul(height, height)))),
    );
    // Volume mode weights radius by cube root so the distribution stays uniform.
    const scaled = params.surfaceOnly
      ? inputs["radius"]
      : fn.mul(inputs["radius"], fn.call("cbrt", rand(fn)));
    const finalRadius = local("rr", scaled);
    const centerX = fn.swizzle(inputs["center"], "x");
    const centerY = fn.swizzle(inputs["center"], "y");
    const centerZ = fn.swizzle(inputs["center"], "z");
    return {
      position: fn.construct(
        VEC3,
        fn.add(centerX, fn.mul(fn.mul(ringRadius, fn.call("cos", theta)), finalRadius)),
        fn.add(centerY, fn.mul(fn.mul(ringRadius, fn.call("sin", theta)), finalRadius)),
        fn.add(centerZ, fn.mul(height, finalRadius)),
      ),
    };
  },
});

/** Scatters particles inside (or on the lateral surface of) a cylinder about an axis. */
export const fxSpawnCylinder = defineNode({
  type: "spawn-cylinder",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is a free choice.
  phaseFlexible: true,
  category: "spawn",
  inputs: {
    radius: { type: "float", value: 1, min: 0, step: 0.1 },
    length: { type: "float", value: 1, min: 0, step: 0.1 },
    center: { type: "vec3", value: [0, 0, 0] },
  },
  outputs: { position: { type: "vec3" } },
  params: { axis: AXIS_PARAM, surfaceOnly: SURFACE_PARAM },
  // theta(3) + inPlaneA/inPlaneB (cos/sin transcendentals, 5 each = 10) + axisOffset(4) + orient
  // (0, a data reshuffle) + the final center add(3) = 20. Volume mode adds an independent
  // rand+sqrt+scale draw for sampledRadius (5).
  cost: ({ params }) => 20 + (params.surfaceOnly === true ? 0 : 5),
  build: ({ inputs, params, local, fn }) => {
    const theta = local("cyl_theta", fn.mul(rand(fn), fn.lit(TWO_PI)));
    // Volume: sampledRadius = radius*sqrt(random) keeps the disc uniform. Surface: sampledRadius
    // = radius (wall).
    const sampledRadius = local(
      "cyl_r",
      params.surfaceOnly ? inputs["radius"] : fn.mul(inputs["radius"], fn.call("sqrt", rand(fn))),
    );
    const inPlaneA = fn.mul(sampledRadius, fn.call("cos", theta));
    const inPlaneB = fn.mul(sampledRadius, fn.call("sin", theta));
    const axisOffset = fn.mul(fn.sub(rand(fn), fn.lit(0.5)), inputs["length"]);
    return {
      position: fn.add(inputs["center"], orient(params.axis, inPlaneA, inPlaneB, axisOffset, fn)),
    };
  },
});

/**
 * Scatters particles inside (or on the lateral surface of) a cone about an axis.
 * The base (full radius) sits at `center`; the apex is `height` along the axis.
 */
export const fxSpawnCone = defineNode({
  type: "spawn-cone",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is a free choice.
  phaseFlexible: true,
  category: "spawn",
  inputs: {
    radius: { type: "float", value: 1, min: 0, step: 0.1 },
    height: { type: "float", value: 1, min: 0, step: 0.1 },
    center: { type: "vec3", value: [0, 0, 0] },
  },
  outputs: { position: { type: "vec3" } },
  params: { axis: AXIS_PARAM, surfaceOnly: SURFACE_PARAM },
  // theta(3) + oneMinusRandom(3) + heightFraction(3) + edgeRadius(2) + inPlaneA/inPlaneB (cos/sin
  // transcendentals, 5 each = 10) + axisOffset(1) + the final center add(3) = 25. Volume mode
  // adds an independent rand+sqrt+scale draw for sampledRadius (5).
  cost: ({ params }) => 25 + (params.surfaceOnly === true ? 0 : 5),
  build: ({ inputs, params, local, fn }) => {
    const theta = local("cone_theta", fn.mul(rand(fn), fn.lit(TWO_PI)));
    // heightFraction in [0, 1] from base to apex, CDF-inverted for uniform density: lateral
    // area grows like (1-t) (sqrt inversion), the volume slice like (1-t)^2 (cbrt inversion).
    const oneMinusRandom = fn.sub(fn.lit(1), rand(fn));
    const heightFraction = local(
      "cone_t",
      params.surfaceOnly
        ? fn.sub(fn.lit(1), fn.call("sqrt", oneMinusRandom))
        : fn.sub(fn.lit(1), fn.call("cbrt", oneMinusRandom)),
    );
    // Radius at heightFraction; volume mode fills the disc uniformly with a further sqrt.
    const edgeRadius = local(
      "cone_edgeR",
      fn.mul(inputs["radius"], fn.sub(fn.lit(1), heightFraction)),
    );
    const sampledRadius = params.surfaceOnly
      ? edgeRadius
      : local("cone_r", fn.mul(edgeRadius, fn.call("sqrt", rand(fn))));
    const inPlaneA = fn.mul(sampledRadius, fn.call("cos", theta));
    const inPlaneB = fn.mul(sampledRadius, fn.call("sin", theta));
    const axisOffset = fn.mul(heightFraction, inputs["height"]);
    return {
      position: fn.add(inputs["center"], orient(params.axis, inPlaneA, inPlaneB, axisOffset, fn)),
    };
  },
});

/** Scatters particles inside (or on the surface of) a torus about an axis. */
export const fxSpawnTorus = defineNode({
  type: "spawn-torus",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is a free choice.
  phaseFlexible: true,
  category: "spawn",
  inputs: {
    major: { type: "float", value: 1, min: 0, step: 0.1 },
    minor: { type: "float", value: 0.25, min: 0, step: 0.05 },
    center: { type: "vec3", value: [0, 0, 0] },
  },
  outputs: { position: { type: "vec3" } },
  params: { axis: AXIS_PARAM, surfaceOnly: SURFACE_PARAM },
  // theta(3)+phi(3) + ringRadius(cos+add+mul=6) + inPlaneA/inPlaneB/axisOffset (cos/sin
  // transcendentals, 5 each = 15) + the final center add(3) = 30. Volume mode adds an
  // independent rand+sqrt+scale draw for the tube radius (5).
  cost: ({ params }) => 30 + (params.surfaceOnly === true ? 0 : 5),
  build: ({ inputs, params, local, fn }) => {
    const theta = local("tor_theta", fn.mul(rand(fn), fn.lit(TWO_PI))); // around the main ring
    const phi = local("tor_phi", fn.mul(rand(fn), fn.lit(TWO_PI))); // around the tube
    // Volume: tube = minor*sqrt(random) fills the tube disc; surface: tube = minor (wall).
    const tube = local(
      "tor_tube",
      params.surfaceOnly ? inputs["minor"] : fn.mul(inputs["minor"], fn.call("sqrt", rand(fn))),
    );
    const ringRadius = local(
      "tor_ringR",
      fn.add(inputs["major"], fn.mul(tube, fn.call("cos", phi))),
    );
    const inPlaneA = fn.mul(ringRadius, fn.call("cos", theta));
    const inPlaneB = fn.mul(ringRadius, fn.call("sin", theta));
    const axisOffset = fn.mul(tube, fn.call("sin", phi));
    return {
      position: fn.add(inputs["center"], orient(params.axis, inPlaneA, inPlaneB, axisOffset, fn)),
    };
  },
});

/**
 * Scatters particles over a flat annulus in the plane perpendicular to the axis. Inner radius
 * 0 gives a full disc; inner == outer gives a thin ring.
 */
export const fxSpawnDisc = defineNode({
  type: "spawn-disc",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is a free choice.
  phaseFlexible: true,
  category: "spawn",
  inputs: {
    innerRadius: { type: "float", value: 0, min: 0, step: 0.1 },
    outerRadius: { type: "float", value: 1, min: 0, step: 0.1 },
    center: { type: "vec3", value: [0, 0, 0] },
  },
  outputs: { position: { type: "vec3" } },
  params: { axis: AXIS_PARAM },
  // theta(3) + inner^2/outer^2 (2) + the mix+sqrt radius draw (7) + inPlaneA/inPlaneB (cos/sin
  // transcendentals, 5 each = 10) + the final center add(3) = 25.
  cost: 25,
  build: ({ inputs, params, local, fn }) => {
    const theta = local("disc_theta", fn.mul(rand(fn), fn.lit(TWO_PI)));
    // Uniform area over the annulus: sampledRadius = sqrt(mix(inner^2, outer^2, random)).
    const innerRadiusSquared = fn.mul(inputs["innerRadius"], inputs["innerRadius"]);
    const outerRadiusSquared = fn.mul(inputs["outerRadius"], inputs["outerRadius"]);
    const sampledRadius = local(
      "disc_r",
      fn.call("sqrt", fn.call("mix", innerRadiusSquared, outerRadiusSquared, rand(fn))),
    );
    const inPlaneA = fn.mul(sampledRadius, fn.call("cos", theta));
    const inPlaneB = fn.mul(sampledRadius, fn.call("sin", theta));
    return {
      position: fn.add(inputs["center"], orient(params.axis, inPlaneA, inPlaneB, fn.lit(0), fn)),
    };
  },
});

/** Seeds velocity as a direction scaled by a random speed (direction not normalized). */
export const fxInitialVelocity = defineNode({
  type: "initial-velocity",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is inferred, not pinned.
  phaseFlexible: true,
  category: "spawn",
  inputs: {
    direction: { type: "vec3", value: [0, 1, 0] },
    speed: { type: "vec2", value: [1, 1] },
  },
  outputs: { velocity: { type: "vec3" } },
  params: {},
  // A random draw (~2) + a scalar mix (~3) + vec3 * scalar (3).
  cost: 8,
  build: ({ inputs, local, fn }) => {
    const speed = local("speed", sampleRange(inputs["speed"], rand(fn), fn));
    return { velocity: fn.mul(inputs["direction"], speed) };
  },
});

/** A fresh per-particle random in [0, 1). Store it into a `seed` attribute to persist it. */
export const fxRandom = defineNode({
  type: "random",
  domain: "behavior",
  phase: "spawn",
  // Value-only: reads no `dt` or update-only state, so its phase is inferred, not pinned.
  phaseFlexible: true,
  category: "source",
  inputs: {},
  outputs: { out: { type: "float" } },
  params: {},
  cost: 2,
  build: ({ fn }) => ({ out: rand(fn) }),
});

/** All standard behavior spawn node definitions. */
export const FX_BEHAVIOR_SPAWN_NODES: readonly FXNodeDefinition[] = [
  fxLifetime,
  fxSpawnBox,
  fxSpawnSphere,
  fxSpawnCylinder,
  fxSpawnCone,
  fxSpawnTorus,
  fxSpawnDisc,
  fxInitialVelocity,
  fxRandom,
];
