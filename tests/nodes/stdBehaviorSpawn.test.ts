import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { attributeSlot, storeAttr } from "../helpers/attr";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

// Only position (stride 3) and lifecycle (stride 2, `[age, lifetime]`) are core buffers.
// velocity/scale/seed are user attributes written through a `store-attribute` node
// (SPAWN phase) bound to `attr:<name>`; the kernel then writes their own named buffers.
// Spawn randomness is inline `Math.random()` (nondeterministic), so per-channel draws
// are asserted by RANGE/shape, not by an exact seeded value.
const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;
const reg = behaviorRegistry();

/** Runs one spawn invocation of a single-particle graph and returns its state buffers. */
function spawnOnce(
  nodes: Readonly<Record<string, FXBehaviorNode>>,
  connections: readonly FXConnection[],
  outputBindings: readonly FXOutputBinding[],
): Record<string, Float32Array> {
  return runKernel(graphOf(nodes, connections, outputBindings), { phase: "spawn" });
}

type Vec3 = readonly [number, number, number];

/** Draws `count` spawn positions (one particle each) from a single position-emitting shape node. */
function positionsOf(type: string, params: Readonly<Record<string, unknown>>, count = 400): Vec3[] {
  const graph = graphOf(
    { shape: reg.create(type, params) },
    [],
    [bind("position", "shape", "position")],
  );
  return Array.from({ length: count }, () => {
    const [x, y, z] = runKernel(graph, { phase: "spawn" }).position;
    return [x, y, z] as const;
  });
}

const EPS = 1e-5;

/** A spawn shape plus the invariant every drawn position must satisfy. */
interface ShapeCase {
  readonly title: string;
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly check: (p: Vec3) => void;
}

const SHAPE_CASES: readonly ShapeCase[] = [
  {
    title: "spawn-box volume stays within the box around its center",
    type: "spawn-box",
    params: { size: [2, 4, 6], center: [1, 2, 3] },
    check: ([x, y, z]) => {
      expect(Math.abs(x - 1)).toBeLessThanOrEqual(1 + EPS);
      expect(Math.abs(y - 2)).toBeLessThanOrEqual(2 + EPS);
      expect(Math.abs(z - 3)).toBeLessThanOrEqual(3 + EPS);
    },
  },
  {
    title: "spawn-box surface only places points on a face of the box",
    type: "spawn-box",
    params: { size: [2, 2, 2], surfaceOnly: true },
    check: (p) => {
      for (const c of p) {
        expect(Math.abs(c)).toBeLessThanOrEqual(1 + EPS);
      }
      expect(p.some((c) => Math.abs(Math.abs(c) - 1) < 1e-6)).toBe(true);
    },
  },
  {
    title: "spawn-sphere volume stays within the radius around its center",
    type: "spawn-sphere",
    params: { radius: 2, center: [1, 0, -1] },
    check: ([x, y, z]) => expect(Math.hypot(x - 1, y, z + 1)).toBeLessThanOrEqual(2 + EPS),
  },
  {
    title: "spawn-sphere surface only pins points to the radius",
    type: "spawn-sphere",
    params: { radius: 2, surfaceOnly: true },
    check: ([x, y, z]) => expect(Math.hypot(x, y, z)).toBeCloseTo(2, 4),
  },
  {
    title: "spawn-cylinder keeps points within radius and half-length about the Y axis",
    type: "spawn-cylinder",
    params: { radius: 2, height: 4, axis: "y" },
    check: ([x, y, z]) => {
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(2 + EPS);
      expect(Math.abs(y)).toBeLessThanOrEqual(2 + EPS); // half of height 4
    },
  },
  {
    title: "spawn-cylinder surface only pins points to the wall radius",
    type: "spawn-cylinder",
    params: { radius: 2, height: 4, surfaceOnly: true },
    check: ([x, , z]) => expect(Math.hypot(x, z)).toBeCloseTo(2, 5),
  },
  {
    title: "spawn-cylinder about X keeps X as the height axis",
    type: "spawn-cylinder",
    params: { radius: 1, height: 4, axis: "x" },
    check: ([x, y, z]) => {
      expect(Math.hypot(y, z)).toBeLessThanOrEqual(1 + EPS); // radial plane is YZ
      expect(Math.abs(x)).toBeLessThanOrEqual(2 + EPS); // height along X
    },
  },
  {
    title: "spawn-cone tapers radius to zero at the apex height",
    type: "spawn-cone",
    params: { radius: 2, height: 4, axis: "y" },
    check: ([x, y, z]) => {
      const t = y / 4; // 0 at base, 1 at apex
      expect(t).toBeGreaterThanOrEqual(-1e-6);
      expect(t).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(2 * (1 - t) + 1e-4);
    },
  },
  {
    title: "spawn-torus stays within the tube of the ring",
    type: "spawn-torus",
    params: { major: 3, minor: 0.5, axis: "y" },
    // Distance from the ring circle (radius=major in the XZ plane) is within the tube.
    check: ([x, y, z]) =>
      expect(Math.hypot(Math.hypot(x, z) - 3, y)).toBeLessThanOrEqual(0.5 + EPS),
  },
  {
    title: "spawn-disc scatters over an annulus in the plane perpendicular to the axis",
    type: "spawn-disc",
    params: { innerRadius: 1, outerRadius: 2, axis: "y" },
    check: ([x, y, z]) => {
      expect(Math.abs(y)).toBeLessThan(1e-6); // flat in the XZ plane
      const radius = Math.hypot(x, z);
      expect(radius).toBeGreaterThanOrEqual(1 - EPS);
      expect(radius).toBeLessThanOrEqual(2 + EPS);
    },
  },
];

describe("spawn shapes", () => {
  it.each(SHAPE_CASES)("$title", ({ type, params, check }) => {
    for (const position of positionsOf(type, params)) {
      check(position);
    }
  });

  it("spawn-box volume fills the box rather than collapsing onto its center", () => {
    const xs = positionsOf("spawn-box", { size: [2, 2, 2] }).map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1);
  });

  it("spawn-sphere volume fills the ball rather than only its surface", () => {
    const radii = positionsOf("spawn-sphere", { radius: 2 }).map((p) => Math.hypot(...p));
    expect(Math.min(...radii)).toBeLessThan(1.5);
  });
});

describe("birth-state nodes", () => {
  it("resets an absent editable-input override to its default on a resident instance", () => {
    // The reset contract is node-agnostic; exercised here via `lifetime`'s editable input.
    const life = reg.create("lifetime", { min: 3, max: 3 });
    const graph = graphOf({ l: life }, [], [bind("lifetime", "l", "value")]);
    expect(runKernel(graph, { phase: "spawn" }).lifecycle[1]).toBe(3);

    // A snapshot omitting `min`/`max` (a "reset to default" serialized as key removal) resets
    // the resident instance to spec default min=max=1 (midpoint 1), not the last [3,3]. The
    // values are inline literals, so they take effect on the next (re)compile.
    life.applyParams?.({});
    expect(runKernel(graph, { phase: "spawn" }).lifecycle[1]).toBe(1);
  });

  it("initial-velocity scales direction by the sampled speed", () => {
    const buffers = spawnOnce(
      {
        v: reg.create("initial-velocity", { direction: [0, 2, 0], speed: [1, 1] }),
        store: storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN),
      },
      [edge("v", "velocity", "store", "value")],
      [bind(attributeSlot("velocity"), "store", "value")],
    );
    expect(buffers.velocity[1]).toBe(2);
  });

  it("lifetime draws stay within its configured range", () => {
    const graph = graphOf(
      { life: reg.create("lifetime", { min: 0, max: 1 }) },
      [],
      [bind("lifetime", "life", "value")],
    );
    for (let i = 0; i < 200; i++) {
      const life = runKernel(graph, { phase: "spawn" }).lifecycle[1];
      expect(life).toBeGreaterThanOrEqual(0);
      expect(life).toBeLessThan(1);
    }
  });

  it("random draws a fresh per-particle value in [0, 1)", () => {
    const graph = graphOf(
      { rng: reg.create("random"), store: storeAttr("seed", FLOAT, FXBehaviorPhase.SPAWN) },
      [edge("rng", "out", "store", "value")],
      [bind(attributeSlot("seed"), "store", "value")],
    );
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const seed = runKernel(graph, { phase: "spawn" }).seed[0];
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(1);
      seen.add(seed);
    }
    // Inline Math.random() -> a fresh draw each call (not a constant, not a seeded channel).
    expect(seen.size).toBeGreaterThan(1);
  });
});
