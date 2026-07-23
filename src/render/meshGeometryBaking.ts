/**
 * Converts between a live `BufferGeometry` and the plain `position`/`normal`/`uv`/`index` arrays a
 * {@link MeshAsset} persists (ADR-0001). Baking runs once at upload; rebuilding runs wherever a
 * mesh asset needs a live geometry again (preview, or the content sheet's GLB re-download).
 */

import { BufferGeometry, Float32BufferAttribute } from "three";
import type { BufferAttribute, InterleavedBufferAttribute } from "three";
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

/** Bakes `geometry`'s position/normal/uv/index into plain flat arrays. Missing normals are
 * computed; missing UVs default to zero; a non-indexed source gets a trivial sequential index. */
export function bakeGeometryArrays(geometry: BufferGeometry): BakedMeshGeometry {
  // @types/three types named attributes as always present; a source mesh can genuinely lack one.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (geometry.getAttribute("normal") === undefined) {
    geometry.computeVertexNormals();
  }
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  // `getIndex()` is the one geometry accessor that returns `null` (three's non-indexed convention),
  // not `undefined` - converted once, right at this boundary.
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

/** Rebuilds a live `BufferGeometry` from a mesh asset's baked arrays. */
export function buildGeometryFromArrays(baked: BakedMeshGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(baked.position, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(baked.normal, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(baked.uv, 2));
  geometry.setIndex(Array.from(baked.index));
  return geometry;
}
