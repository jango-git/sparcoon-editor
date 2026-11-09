import { describe, expect, it } from "vitest";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { compileBehaviorStandard } from "../../src/engine/behavior/FXParticleBehaviorKernelStandard.Internal";
import { buildParticleBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { attributeSlot, readAttr, storeAttr } from "../helpers/attr";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

// Velocity is an ordinary user attribute: a force node reads it through a `custom-attribute`
// node and its result is persisted through a `store-attribute` bound to `attr:velocity`;
// motion is an explicit `integrate-motion` node. So a force test asserts on the `velocity`
// attribute buffer (stride 3) and, where it verifies motion, on the core `position` buffer.
const VEC3 = FX_VALUE_TYPES.vec3;
const OFF_Y = 1; // y within a stride-3 vec3 buffer (position or velocity)
const reg = behaviorRegistry();

/**
 * custom-attribute(velocity) -> gravity -> drag -> { store-attribute(velocity),
 * integrate-motion -> position }. The velocity attribute accumulates the force and the
 * new position is the explicit Euler step over the post-force velocity.
 */
function gravityDragGraph(damping: number): { graph: FXGraph<FXBehaviorNode>; g: FXBehaviorNode } {
  const g = reg.create("gravity", { acceleration: [0, -10, 0] });
  const graph = graphOf(
    {
      rv: readAttr("velocity", VEC3),
      g,
      d: reg.create("drag", { damping }),
      sv: storeAttr("velocity", VEC3),
      im: reg.create("integrate-motion"),
    },
    [
      edge("rv", "value", "g", "velocity"),
      edge("g", "velocity", "d", "velocity"),
      edge("d", "velocity", "sv", "value"),
      edge("d", "velocity", "im", "velocity"),
    ],
    [bind(attributeSlot("velocity"), "sv", "value"), bind("position", "im", "position")],
  );
  return { graph, g };
}

/** `node` (velocity input left at its zero default) -> store-attribute(velocity). */
function velocityOnly(node: FXBehaviorNode): FXGraph<FXBehaviorNode> {
  return graphOf(
    { n: node, sv: storeAttr("velocity", VEC3) },
    [edge("n", "velocity", "sv", "value")],
    [bind(attributeSlot("velocity"), "sv", "value")],
  );
}

/** One update step of a velocity-only force graph for a particle at `position`. */
function velocityAfterStep(
  node: FXBehaviorNode,
  position: readonly number[],
  dt: number,
): [number, number, number] {
  const buffers = runKernel(velocityOnly(node), { dt, state: { position } });
  const [x, y, z] = buffers.velocity;
  return [x, y, z];
}

function expectVec(actual: readonly number[], expected: readonly number[], digits = 5): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));
}

describe("gravity and drag", () => {
  it("gravity -> drag(0) integrates v += a*dt and advances position", () => {
    const buffers = runKernel(gravityDragGraph(0).graph, { dt: 0.5 });
    expect(buffers.velocity[OFF_Y]).toBeCloseTo(-5, 6);
    expect(buffers.position[OFF_Y]).toBeCloseTo(-2.5, 6);
  });

  it("gravity -> drag(2) applies exponential damping", () => {
    const buffers = runKernel(gravityDragGraph(2).graph, { dt: 0.5 });
    expect(buffers.velocity[OFF_Y]).toBeCloseTo(-5 * Math.exp(-1), 6);
  });

  it("an acceleration re-tuned through applyParams bakes into the next compile", () => {
    const { graph, g } = gravityDragGraph(0);
    g.applyParams?.({ acceleration: [0, -20, 0] });
    // v_y += -20 * 0.5 = -10.
    expect(runKernel(graph, { dt: 0.5 }).velocity[OFF_Y]).toBeCloseTo(-10, 6);
  });

  it("drag rejects a negative damping coefficient", () => {
    expect(() => reg.create("drag", { damping: -1 })).toThrow(/within/);
  });
});

describe("point-force", () => {
  // Particle at (2, 0, 0), center at the origin: distance 2, direction -x. The kick is
  // strength * dt * falloff along the unit direction toward the center.
  it.each([
    ["none", -2],
    ["linear", -1],
    ["inverse-square", -0.5],
  ])("falloff %s scales the pull toward the center", (falloff, expectedX) => {
    const node = reg.create("point-force", { falloff, strength: 4, center: [0, 0, 0] });
    expectVec(velocityAfterStep(node, [2, 0, 0], 0.5), [expectedX, 0, 0]);
  });

  it("a negative strength pushes away from the center", () => {
    const node = reg.create("point-force", { falloff: "none", strength: -4, center: [0, 0, 0] });
    expectVec(velocityAfterStep(node, [0, 2, 0], 0.5), [0, 2, 0]);
  });

  it("stays finite for a particle sitting exactly on the center", () => {
    const node = reg.create("point-force", { falloff: "inverse-square", center: [1, 1, 1] });
    expectVec(velocityAfterStep(node, [1, 1, 1], 0.5), [0, 0, 0]);
  });
});

describe("vortex", () => {
  // Particle at (1, 0, 0) around the +y axis through the origin: the unit radial is +x, the
  // tangent is axis x radial = (0, 0, -1).
  it("swirls tangentially around the axis at `strength`", () => {
    const node = reg.create("vortex", { strength: 2, axis: [0, 1, 0], center: [0, 0, 0] });
    expectVec(velocityAfterStep(node, [1, 0, 0], 0.5), [0, 0, -1]);
  });

  it("pulls toward the axis by `inward` alongside the swirl", () => {
    const node = reg.create("vortex", { strength: 2, inward: 1, axis: [0, 1, 0] });
    expectVec(velocityAfterStep(node, [1, 0, 0], 0.5), [-0.5, 0, -1]);
  });

  it("normalizes a non-unit axis and ignores the axial offset", () => {
    const node = reg.create("vortex", { strength: 2, axis: [0, 5, 0], center: [0, 0, 0] });
    expectVec(velocityAfterStep(node, [1, 7, 0], 0.5), [0, 0, -1]);
  });

  it("leaves velocity unchanged for a zero axis instead of producing NaN", () => {
    const node = reg.create("vortex", { strength: 2, axis: [0, 0, 0] });
    expectVec(velocityAfterStep(node, [1, 0, 0], 0.5), [0, 0, 0]);
  });

  it("leaves velocity unchanged for a particle on the axis (zero radius)", () => {
    const node = reg.create("vortex", { strength: 2, inward: 1, axis: [0, 1, 0] });
    expectVec(velocityAfterStep(node, [0, 3, 0], 0.5), [0, 0, 0]);
  });
});

describe("firework", () => {
  // A SPAWN-phase velocity seeder: each particle gets a burst velocity of magnitude `strength`
  // in a random direction inside the cone. The direction is random, so it is asserted through
  // the deterministic invariants - the exact axis at angle 0, constant speed and the cone bound
  // at a positive angle.
  function fireworkVelocity(params: Record<string, unknown>): Float32Array {
    const graph = graphOf(
      {
        n: reg.create("firework", params),
        sv: storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN),
      },
      [edge("n", "velocity", "sv", "value")],
      [bind(attributeSlot("velocity"), "sv", "value")],
    );
    return runKernel(graph, { phase: "spawn" }).velocity;
  }

  it("at cone angle 0 seeds velocity straight up the axis (v = axis*strength)", () => {
    expectVec([...fireworkVelocity({ strength: 4, angle: 0, axis: [0, 1, 0] })], [0, 4, 0], 6);
  });

  it("at a positive cone angle seeds a random outward burst of constant speed", () => {
    const strength = 4;
    const angle = 0.5;
    for (let i = 0; i < 24; i += 1) {
      const [x, y, z] = fireworkVelocity({ strength, angle, axis: [0, 1, 0] });
      expect(Math.hypot(x, y, z)).toBeCloseTo(strength, 5); // |dir| = 1 -> speed = strength
      // axis (y) component = strength*cos(theta), theta in [0, angle].
      expect(y).toBeGreaterThanOrEqual(strength * Math.cos(angle) - 1e-4);
      expect(y).toBeLessThanOrEqual(strength + 1e-4);
    }
  });
});

describe("turbulence", () => {
  const turbulenceGraph = (params: Record<string, unknown>): FXGraph<FXBehaviorNode> =>
    velocityOnly(reg.create("turbulence", params));

  it("every velocity channel depends on the full 3D position, not just its own axis", () => {
    const graph = turbulenceGraph({ amplitude: 2, frequency: 1, octaves: 4 });
    const sampleAt = (position: readonly number[]): Float32Array =>
      runKernel(graph, { state: { position, lifecycle: [0.5, 0] } }).velocity;
    const base = sampleAt([0, 0, 0]);
    const movedAlongX = sampleAt([3.7, 0, 0]);
    expect(movedAlongX[1]).not.toBeCloseTo(base[1], 4);
    expect(movedAlongX[2]).not.toBeCloseTo(base[2], 4);
  });

  it("compiles on the standard (GLSL) tier, sampling the position through one shared fxFbm3 helper", () => {
    // No GLSL compiler runs headless, so the observable is the emitted text: the body samples
    // the vector-domain fBm from the particle position and the helper is emitted once.
    const compiled = compileBehaviorStandard(
      turbulenceGraph({ amplitude: 2, frequency: 1 }),
      buildParticleBehaviorTargets([{ name: "velocity", type: VEC3 }]),
    );
    const body = compiled.update.body.join("\n");
    expect(body).toContain("in_position");
    expect(body).toContain("fxFbm3(");
    expect(compiled.update.helpers.filter((h) => h.includes("float fxFbm3("))).toHaveLength(1);
  });

  it("bounds octaves so a runaway value cannot freeze the loop", () => {
    // `octaves` scales the fBm loop count; its `max` gates it at coerce, so a runaway 1e8 from
    // a scrub or a bad snapshot is rejected instead of running particleCount * 1e8 iterations.
    expect(() => reg.create("turbulence", { amplitude: 1, frequency: 1, octaves: 1e8 })).toThrow(
      /octaves must be within \[0, 8\]/,
    );
    // The in-range maximum compiles and runs finite.
    const graph = turbulenceGraph({ amplitude: 1, frequency: 1, octaves: 8 });
    const velocity = runKernel(graph, { state: { lifecycle: [0.5, 0] } }).velocity;
    expect([...velocity].every(Number.isFinite)).toBe(true);
  });
});
