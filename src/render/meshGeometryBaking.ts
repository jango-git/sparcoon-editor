/**
 * Converts a live `BufferGeometry` to and from the plain `position`/`normal`/`uv`/`index` arrays of
 * a {@link MeshAsset}.
 */

import type { BufferAttribute, InterleavedBufferAttribute } from "three";
import { BufferGeometry, Float32BufferAttribute, Mesh } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

import type { BakedMeshGeometry } from "../model/editorState";

/** Read via `getX/getY`, not raw `.array` - a GLTFLoader attribute is often an
 * `InterleavedBufferAttribute` sharing one buffer across position/normal/uv. */
type VertexAttribute = BufferAttribute | InterleavedBufferAttribute;

function flattenVec2(attribute: VertexAttribute, vertexCount: number): number[] {
  const values = new Array<number>(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    values[i * 2] = attribute.getX(i);
    values[i * 2 + 1] = attribute.getY(i);
  }
  return values;
}

function flattenVec3(attribute: VertexAttribute, vertexCount: number): number[] {
  const values = new Array<number>(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    values[i * 3] = attribute.getX(i);
    values[i * 3 + 1] = attribute.getY(i);
    values[i * 3 + 2] = attribute.getZ(i);
  }
  return values;
}

/**
 * Missing normals are computed, missing UVs are zero, a non-indexed source gets a sequential index.
 */
export function bakeGeometryArrays(geometry: BufferGeometry): BakedMeshGeometry {
  // @types/three types named attributes as always present; a source mesh can genuinely lack one.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (geometry.getAttribute("normal") === undefined) {
    geometry.computeVertexNormals();
  }
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  // `getIndex()` returns `null` for non-indexed geometry.
  const index = geometry.getIndex() ?? undefined;

  const vertexCount = position.count;
  return {
    position: flattenVec3(position, vertexCount),
    normal: flattenVec3(normal, vertexCount),
    uv:
      // @types/three types this attribute as always present; a source mesh can genuinely lack it.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      uv === undefined ? new Array<number>(vertexCount * 2).fill(0) : flattenVec2(uv, vertexCount),
    index:
      index === undefined
        ? Array.from({ length: vertexCount }, (_, vertexIndex) => vertexIndex)
        : Array.from(index.array),
  };
}

export function buildGeometryFromArrays(baked: BakedMeshGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(baked.position, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(baked.normal, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(baked.uv, 2));
  geometry.setIndex(Array.from(baked.index));
  return geometry;
}

/** Single-mesh GLB written from the baked arrays, since the uploaded bytes are not kept. */
export async function encodeMeshGlb(baked: BakedMeshGeometry): Promise<ArrayBuffer> {
  const geometry = buildGeometryFromArrays(baked);
  try {
    return (await new GLTFExporter().parseAsync(new Mesh(geometry), {
      binary: true,
    })) as ArrayBuffer;
  } finally {
    geometry.dispose();
  }
}
