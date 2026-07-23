import { defineNode } from "../../core/nodes/defineNode";
import type { FXNodeDefinition } from "../../core/nodes/defineNode";
import { DT_INPUT, VELOCITY_INPUT } from "./common";

/**
 * Euler integration nodes (update phase). Motion is not a hidden target epilogue - it is an
 * explicit node the graph wires: `read-attribute(velocity)` -> {@link fxIntegrateMotion} -> `position`.
 */

/** Advances position by a velocity input over `dt` (`position += velocity * dt`). */
export const fxIntegrateMotion = defineNode({
  type: "integrate-motion",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    velocity: VELOCITY_INPUT,
    // Timestep this step integrates over; defaults to the simulation `dt` but can be
    // driven (e.g. a scaled/clamped dt) by wiring the socket.
    dt: DT_INPUT,
  },
  outputs: { position: { type: "vec3" } },
  params: {},
  // vec3 * float (3 multiplies) + vec3 add (3).
  cost: 6,
  reads: ["PARTICLE_POSITION"],
  build: ({ inputs, target, fn }) => ({
    position: fn.add(target.read("PARTICLE_POSITION"), fn.mul(inputs["velocity"], inputs["dt"])),
  }),
});

/** Generic scalar Euler step, `value += rate * dt` - e.g. `rotation += torque * dt`. */
export const fxIntegrate = defineNode({
  type: "integrate",
  domain: "behavior",
  phase: "update",
  category: "force",
  inputs: {
    value: { type: "float", value: 0 },
    rate: { type: "float", value: 0 },
    // Timestep this step integrates over; defaults to the simulation `dt`, overridable
    // by wiring the socket.
    dt: DT_INPUT,
  },
  outputs: { value: { type: "float" } },
  params: {},
  // A multiply + an add.
  cost: 2,
  build: ({ inputs, fn }) => ({
    value: fn.add(inputs["value"], fn.mul(inputs["rate"], inputs["dt"])),
  }),
});

/** All standard Euler-integration behavior node definitions. */
export const FX_BEHAVIOR_INTEGRATE_NODES: readonly FXNodeDefinition[] = [
  fxIntegrateMotion,
  fxIntegrate,
];
