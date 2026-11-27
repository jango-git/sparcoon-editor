/**
 * Converts a live mesh to and from the flat arrays of a {@link MeshAsset}: its geometry, and the
 * skin, skeleton and bone clips of a skinned one.
 */

import type {
  BufferAttribute,
  InterleavedBufferAttribute,
  InterpolationModes,
  Material,
} from "three";
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  InterpolateDiscrete,
  InterpolateLinear,
  type KeyframeTrack,
  Matrix4,
  Mesh,
  type Object3D,
  PropertyBinding,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  VectorKeyframeTrack,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

import {
  type BakedBone,
  type BakedClip,
  type BakedMeshGeometry,
  type BakedMeshSkin,
  type BakedTrack,
  MATRIX_FLOATS,
} from "../model/editorState";

/** Read via `getX/getY`, not raw `.array` - a GLTFLoader attribute is often an
 * `InterleavedBufferAttribute` sharing one buffer across position/normal/uv. */
type VertexAttribute = BufferAttribute | InterleavedBufferAttribute;

const COMPONENT_READERS = ["getX", "getY", "getZ", "getW"] as const;

/** The first `itemSize` components of each of the first `vertexCount` vertices of `attribute`. */
function flattenAttribute(
  attribute: VertexAttribute,
  itemSize: 2 | 3 | 4,
  vertexCount: number,
): Float32Array<ArrayBuffer> {
  const values = new Float32Array(vertexCount * itemSize);
  const readers = COMPONENT_READERS.slice(0, itemSize);
  for (let i = 0; i < vertexCount; i++) {
    readers.forEach((read, component) => {
      values[i * itemSize + component] = attribute[read](i);
    });
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
    position: flattenAttribute(position, 3, vertexCount),
    normal: flattenAttribute(normal, 3, vertexCount),
    uv:
      // @types/three types this attribute as always present; a source mesh can genuinely lack it.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      uv === undefined ? new Float32Array(vertexCount * 2) : flattenAttribute(uv, 2, vertexCount),
    index:
      index === undefined
        ? Uint32Array.from({ length: vertexCount }, (_, vertexIndex) => vertexIndex)
        : Uint32Array.from(index.array),
  };
}

/**
 * {@link bakeGeometryArrays} of `mesh`'s geometry, with the skin of a skinned mesh that has
 * `skinIndex` and `skinWeight`: its skeleton and the tracks of `animations` that move its bones.
 * Geometry is baked in the mesh's own space, with the mesh's place in its file's scene. The mesh's
 * scene must have its world matrices updated.
 */
export function bakeMeshArrays(
  mesh: Mesh,
  animations: readonly AnimationClip[],
): BakedMeshGeometry {
  const geometry = { ...bakeGeometryArrays(mesh.geometry), matrix: mesh.matrixWorld.toArray() };
  const skinIndex = mesh.geometry.getAttribute("skinIndex") as VertexAttribute | undefined;
  const skinWeight = mesh.geometry.getAttribute("skinWeight") as VertexAttribute | undefined;
  if (
    !(mesh instanceof SkinnedMesh) ||
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- unbound until bind()
    mesh.skeleton === undefined ||
    skinIndex === undefined ||
    skinWeight === undefined
  ) {
    return geometry;
  }
  const count = geometry.position.length / 3;
  return {
    ...geometry,
    skin: {
      skinIndex: flattenAttribute(skinIndex, 4, count),
      skinWeight: flattenAttribute(skinWeight, 4, count),
      bindMatrix: mesh.bindMatrix.toArray(),
      ...bakeSkeleton(mesh),
      clips: bakeClips(animations, new Set(mesh.skeleton.bones.map((bone) => bone.name))),
    },
  };
}

/**
 * The bones of `mesh`'s skeleton, each root under its parent's world matrix in the file's scene,
 * and their inverse bind matrices.
 */
function bakeSkeleton(mesh: SkinnedMesh): Pick<BakedMeshSkin, "bones" | "boneInverses"> {
  const { bones, boneInverses } = mesh.skeleton;
  const baked = bones.map((bone): BakedBone => {
    bone.updateMatrix();
    const parent = bone.parent instanceof Bone ? bones.indexOf(bone.parent) : -1;
    return {
      name: bone.name,
      parent,
      matrix: bone.matrix.toArray(),
      ...(parent === -1
        ? { parentMatrix: (bone.parent?.matrixWorld ?? new Matrix4()).toArray() }
        : {}),
    };
  });
  const inverses = new Float32Array(bones.length * MATRIX_FLOATS);
  boneInverses.forEach((inverse, index) => {
    inverse.toArray(inverses, index * MATRIX_FLOATS);
  });
  return { bones: baked, boneInverses: inverses };
}

/** The bone properties a clip's tracks keep, each with the track type it is keyed by. */
const BONE_TRACK_TYPES: ReadonlyMap<
  string,
  new (
    name: string,
    times: ArrayLike<number>,
    values: ArrayLike<number>,
    interpolation: InterpolationModes,
  ) => KeyframeTrack
> = new Map([
  ["position", VectorKeyframeTrack],
  ["quaternion", QuaternionKeyframeTrack],
  ["scale", VectorKeyframeTrack],
]);

/** three's interpolation of each baked one. */
const INTERPOLATIONS: Readonly<Record<BakedTrack["interpolation"], InterpolationModes>> = {
  discrete: InterpolateDiscrete,
  linear: InterpolateLinear,
};

/**
 * The clips of `animations` cut to the tracks that move one of `bones`, each keyed at its own
 * times with its interpolant's values there: a cubic spline track becomes a linear one through its
 * keys. A clip left with no track is dropped.
 */
function bakeClips(
  animations: readonly AnimationClip[],
  bones: ReadonlySet<string>,
): readonly BakedClip[] {
  return animations.flatMap((clip) => {
    const tracks = clip.tracks.flatMap((track): BakedTrack[] => {
      const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
      return bones.has(nodeName) && BONE_TRACK_TYPES.has(propertyName) ? [bakeTrack(track)] : [];
    });
    return tracks.length === 0 ? [] : [{ name: clip.name, duration: clip.duration, tracks }];
  });
}

function bakeTrack(track: KeyframeTrack): BakedTrack {
  const size = track.getValueSize();
  const interpolant = track.createInterpolant();
  const values = new Float32Array(track.times.length * size);
  track.times.forEach((time, key) => {
    values.set(interpolant.evaluate(time), key * size);
  });
  return {
    name: track.name,
    interpolation: track.getInterpolation() === InterpolateDiscrete ? "discrete" : "linear",
    times: Float32Array.from(track.times),
    values,
  };
}

/** The geometry of `baked`, with the skin attributes of a skinned mesh. */
export function buildGeometryFromArrays(baked: BakedMeshGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(baked.position, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(baked.normal, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(baked.uv, 2));
  if (baked.skin !== undefined) {
    geometry.setAttribute("skinIndex", new Float32BufferAttribute(baked.skin.skinIndex, 4));
    geometry.setAttribute("skinWeight", new Float32BufferAttribute(baked.skin.skinWeight, 4));
  }
  geometry.setIndex(Array.from(baked.index));
  return geometry;
}

/** A mesh built from baked arrays: the object tree to add to a scene, the mesh in it (skinned for
 *  a skinned asset, at the root's origin), and the clips of its skin. */
export interface BuiltMesh {
  readonly root: Object3D;
  readonly mesh: Mesh;
  readonly clips: readonly AnimationClip[];
}

/** `baked` as a mesh drawn with `material`, placed as in its file. A skinned one is bound as in
 *  its file, its bones in their baked pose, and never frustum-culled, since its bounds are those
 *  of the unposed mesh. */
export function buildMesh(baked: BakedMeshGeometry, material?: Material): BuiltMesh {
  const geometry = buildGeometryFromArrays(baked);
  const skin = baked.skin;
  if (skin === undefined) {
    const mesh = place(new Mesh(geometry, material), baked);
    return { root: mesh, mesh, clips: [] };
  }
  const root = new Group();
  const bones = skin.bones.map((baked) => {
    const bone = new Bone();
    bone.name = baked.name;
    new Matrix4().fromArray(baked.matrix).decompose(bone.position, bone.quaternion, bone.scale);
    return bone;
  });
  skin.bones.forEach((baked, index) => {
    const bone = bones[index] as Bone;
    const parent = bones[baked.parent];
    if (parent !== undefined) {
      parent.add(bone);
      return;
    }
    const frame = new Group();
    new Matrix4()
      .fromArray(baked.parentMatrix ?? new Matrix4().elements)
      .decompose(frame.position, frame.quaternion, frame.scale);
    frame.add(bone);
    root.add(frame);
  });
  const inverses = bones.map((_, index) =>
    new Matrix4().fromArray(skin.boneInverses, index * MATRIX_FLOATS),
  );
  const mesh = place(new SkinnedMesh(geometry, material), baked);
  mesh.frustumCulled = false;
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones, inverses), new Matrix4().fromArray(skin.bindMatrix));
  return { root, mesh, clips: skin.clips.map(buildClip) };
}

/** `mesh` placed where `baked`'s file places it. */
function place<M extends Mesh>(mesh: M, baked: BakedMeshGeometry): M {
  if (baked.matrix !== undefined) {
    new Matrix4().fromArray(baked.matrix).decompose(mesh.position, mesh.quaternion, mesh.scale);
  }
  return mesh;
}

function buildClip(baked: BakedClip): AnimationClip {
  return new AnimationClip(
    baked.name,
    baked.duration,
    baked.tracks.map((track) => {
      const { propertyName } = PropertyBinding.parseTrackName(track.name);
      const Track = BONE_TRACK_TYPES.get(propertyName) ?? VectorKeyframeTrack;
      return new Track(track.name, track.times, track.values, INTERPOLATIONS[track.interpolation]);
    }),
  );
}

/** Single-mesh GLB written from the baked arrays, since the uploaded bytes are not kept - a skinned
 *  mesh with its skeleton and clips. */
export async function encodeMeshGlb(baked: BakedMeshGeometry): Promise<ArrayBuffer> {
  const { root, mesh, clips } = buildMesh(baked);
  try {
    return (await new GLTFExporter().parseAsync(root, {
      binary: true,
      animations: [...clips],
    })) as ArrayBuffer;
  } finally {
    mesh.geometry.dispose();
  }
}
