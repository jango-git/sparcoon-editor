import { describe, expect, it } from "vitest";
import type { BufferGeometry } from "three";
import { resolveGeometrySource } from "sparcoon/editor";
import type { FXGeometryPrimitive } from "sparcoon";

// The runtime instances one of these built-in primitives per particle; each carries the
// standard position/uv/normal attributes + an index the geometry-agnostic epilogue transforms.

/** `resolveGeometrySource` for a bare built-in primitive - no custom-geometry map needed. */
function buildPrimitiveGeometry(primitive: FXGeometryPrimitive): BufferGeometry {
  return resolveGeometrySource({ type: "primitive", primitive }, {});
}

function attrs(g: BufferGeometry): {
  position: number;
  hasUv: boolean;
  hasNormal: boolean;
  indexed: boolean;
} {
  return {
    position: g.getAttribute("position").count,
    // three.js types getAttribute() as always-present for standard names, but at
    // runtime a geometry that never set uv/normal returns undefined - guard for real.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    hasUv: g.getAttribute("uv") !== undefined,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    hasNormal: g.getAttribute("normal") !== undefined,
    indexed: (g.getIndex() ?? undefined) !== undefined,
  };
}

describe("primitive geometry", () => {
  it("plane is the unit billboard quad (4 verts, uv + normal, indexed)", () => {
    const g = attrs(buildPrimitiveGeometry("plane"));
    expect(g.position).toBe(4);
    expect(g.hasUv).toBe(true);
    expect(g.hasNormal).toBe(true);
    expect(g.indexed).toBe(true);
  });

  it("box and sphere are true 3D meshes with more vertices than the plane", () => {
    const box = attrs(buildPrimitiveGeometry("box"));
    const sphere = attrs(buildPrimitiveGeometry("sphere"));
    expect(box.position).toBeGreaterThan(4);
    expect(sphere.position).toBeGreaterThan(4);
    for (const g of [box, sphere]) {
      expect(g.hasUv).toBe(true);
      expect(g.hasNormal).toBe(true);
      expect(g.indexed).toBe(true);
    }
  });
});
