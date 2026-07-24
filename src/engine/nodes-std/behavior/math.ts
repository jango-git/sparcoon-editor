import { defineNode } from "../../core/nodes/defineNode";
import type { FXNodeDefinition } from "../../core/nodes/defineNode";

/**
 * Behavior-only math nodes: they read per-particle builtin state, so they cannot compile against
 * the render backend (the type-polymorphic primitives live in `../shared/math` instead).
 */

/**
 * Scalar core builtins a `read-state` node can sample. Velocity/scale/rotation/torque and
 * per-particle randoms are ordinary attributes instead, read through `custom-attribute`.
 */
const READ_STATE_BUILTINS: readonly string[] = [
  "PARTICLE_POSITION_X",
  "PARTICLE_POSITION_Y",
  "PARTICLE_POSITION_Z",
  "PARTICLE_AGE",
  "PARTICLE_LIFETIME",
  "PARTICLE_ID",
  "dt",
];

/** Reads a per-particle scalar builtin; the chosen builtin is structural. */
export const fxReadState = defineNode({
  type: "read-state",
  domain: "behavior",
  phase: "param",
  category: "source",
  inputs: {},
  outputs: { out: { type: "float" } },
  params: {
    builtin: {
      kind: "structural",
      type: "enum",
      options: READ_STATE_BUILTINS,
      default: "PARTICLE_AGE",
    },
  },
  // A builtin read, no arithmetic.
  cost: 0,
  reads: (params) => [params["builtin"] as string],
  build: ({ params, target }) => ({ out: target.read(params.builtin) }),
});

/**
 * The simulation timestep of the current update (`dt`, seconds). `dt` is an update-kernel-only
 * input, so placement-inference pins any reading graph into the update phase.
 */
export const fxDeltaTime = defineNode({
  type: "delta-time",
  domain: "behavior",
  phase: "param",
  category: "source",
  inputs: {},
  outputs: { out: { type: "float" } },
  params: {},
  // A builtin read, no arithmetic.
  cost: 0,
  reads: ["dt"],
  build: ({ target }) => ({ out: target.read("dt") }),
});

/** All standard behavior-only math node definitions. */
export const FX_BEHAVIOR_MATH_NODES: readonly FXNodeDefinition[] = [fxReadState, fxDeltaTime];
