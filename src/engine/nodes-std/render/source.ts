import type { FXNodeDefinition } from "../../core/nodes/defineNode";
import { defineNode } from "../../core/nodes/defineNode";

/**
 * Standard-library render source nodes: scalar/coordinate producers that read a host-provided
 * builtin (UV, clock, camera distance, normalized life). `stage: "param"` on the stage-agnostic
 * ones lets placement infer into a vertex-stage chain as well as fragment. A plain constant comes
 * from the shared `constant` node instead; a per-particle builtin from `builtin-attribute`.
 */

/** The global clock (`u_time`, seconds since start) as a float source. */
export const fxTime = defineNode({
  type: "time",
  domain: "render",
  stage: "param",
  category: "source",
  inputs: {},
  outputs: { out: { type: "float" } },
  params: {},
  cost: 0,
  reads: ["u_time"],
  build: ({ target }) => ({ out: target.read("u_time") }),
});

/**
 * Time elapsed since the previous frame (`u_deltaTime`, seconds), supplied per frame by the
 * material adapter's `FXWorld.update` tick. Mirrors the behavior `delta-time` source.
 */
export const fxDeltaTime = defineNode({
  type: "delta-time",
  domain: "render",
  stage: "param",
  category: "source",
  inputs: {},
  outputs: { out: { type: "float" } },
  params: {},
  cost: 0,
  reads: ["u_deltaTime"],
  build: ({ target }) => ({ out: target.read("u_deltaTime") }),
});

/**
 * Normalized particle age, `clamp(age / lifetime, 0, 1)`. Shared across backends: it reads only
 * `PARTICLE_AGE`/`PARTICLE_LIFETIME`, which both the render and behavior particle targets expose.
 */
export const fxLifeRatio = defineNode({
  type: "life-ratio",
  domain: "shared",
  stage: "param",
  phase: "param",
  category: "source",
  inputs: {},
  outputs: { out: { type: "float" } },
  params: {},
  // A divide (2) + a saturate (1).
  cost: 3,
  reads: ["PARTICLE_AGE", "PARTICLE_LIFETIME"],
  build: ({ target, fn }) => ({
    out: fn.call("saturate", fn.div(target.read("PARTICLE_AGE"), target.read("PARTICLE_LIFETIME"))),
  }),
});

/** The interpolated particle UV (`p_uv`) as a first-class vec2 source. */
export const fxUV = defineNode({
  type: "uv",
  domain: "render",
  stage: "fragment",
  category: "uv",
  inputs: {},
  outputs: { uv: { type: "vec2" } },
  params: {},
  cost: 0,
  reads: ["p_uv"],
  build: ({ target }) => ({ uv: target.read("p_uv") }),
});

/** View-space distance from the camera to the particle, as a float source. */
export const fxCameraDistance = defineNode({
  type: "camera-distance",
  domain: "render",
  stage: "fragment",
  category: "source",
  inputs: {},
  outputs: { out: { type: "float" } },
  params: {},
  cost: 0,
  reads: ["p_cameraDistance"],
  build: ({ target }) => ({ out: target.read("p_cameraDistance") }),
});

/**
 * All standard render source node definitions. A constant RGBA color is not a dedicated node -
 * use a `constant` with its `color` type instead (a `vec4` edited via a color picker).
 */
export const FX_RENDER_SOURCE_NODES: readonly FXNodeDefinition[] = [
  fxTime,
  fxDeltaTime,
  fxLifeRatio,
  fxUV,
  fxCameraDistance,
];
