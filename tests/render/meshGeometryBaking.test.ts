import { describe, expect, it } from "vitest";
import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
} from "three";
import { bakeGeometryArrays, buildGeometryFromArrays } from "../../src/render/meshGeometryBaking";

/** A unit-square (2 triangles), non-interleaved position/normal/uv + index. */
function planeGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3),
  );
  geometry.setAttribute(
    "normal",
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
  );
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

describe("bakeGeometryArrays / buildGeometryFromArrays", () => {
  it("round-trips position/normal/uv/index", () => {
    const baked = bakeGeometryArrays(planeGeometry());
    expect(baked.position).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect(baked.normal).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(baked.uv).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(baked.index).toEqual([0, 1, 2, 0, 2, 3]);

    const rebuilt = buildGeometryFromArrays(baked);
    expect(Array.from(rebuilt.getAttribute("position").array)).toEqual(baked.position);
    expect(rebuilt.getIndex()?.count).toBe(6);
  });

  it("reads correct per-vertex values from an interleaved attribute, not the raw shared buffer", () => {
    // Real-world GLB exports commonly interleave position+normal+uv into one buffer (GLTFLoader
    // then produces InterleavedBufferAttribute for each) - reading `.array` directly would return
    // the whole interleaved buffer instead of just this attribute's own components.
    const stride = 8; // position(3) + normal(3) + uv(2)
    // 0.5/0.25 fractions are exact in float32, unlike 0.1/0.3 - keeps the assertion free of
    // precision-rounding noise unrelated to what this test checks.
    const interleaved = new InterleavedBuffer(
      new Float32Array([
        // vertex 0: position, normal, uv
        1, 2, 3, 0, 1, 0, 0.5, 0.25,
        // vertex 1
        4, 5, 6, 0, 1, 0, 0.75, 1,
      ]),
      stride,
    );
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new InterleavedBufferAttribute(interleaved, 3, 0));
    geometry.setAttribute("normal", new InterleavedBufferAttribute(interleaved, 3, 3));
    geometry.setAttribute("uv", new InterleavedBufferAttribute(interleaved, 2, 6));

    const baked = bakeGeometryArrays(geometry);
    expect(baked.position).toEqual([1, 2, 3, 4, 5, 6]);
    expect(baked.normal).toEqual([0, 1, 0, 0, 1, 0]);
    expect(baked.uv).toEqual([0.5, 0.25, 0.75, 1]);
  });

  it("computes normals when the source geometry has none", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2]);

    const baked = bakeGeometryArrays(geometry);
    expect(baked.normal).toHaveLength(9);
    expect(baked.normal.some((component) => component !== 0)).toBe(true);
  });

  it("defaults uv to zero when the source geometry has none", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    geometry.setAttribute(
      "normal",
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    );
    geometry.setIndex([0, 1, 2]);

    const baked = bakeGeometryArrays(geometry);
    expect(baked.uv).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("synthesizes a sequential index for a non-indexed geometry", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    geometry.setAttribute(
      "normal",
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    );

    const baked = bakeGeometryArrays(geometry);
    expect(baked.index).toEqual([0, 1, 2]);
  });
});
