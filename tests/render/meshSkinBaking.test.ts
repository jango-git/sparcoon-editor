import {
  AnimationClip,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Vector3,
  VectorKeyframeTrack,
} from "three";
import { describe, expect, it } from "vitest";

import { createInitialState, type MeshAsset } from "../../src/model/editorState";
import { DEFAULT_VIEWPORT_VIEW } from "../../src/model/viewportView";
import { serializeProject } from "../../src/persistence/projectFile";
import { bakeMeshArrays, buildMesh } from "../../src/render/meshGeometryBaking";
import { loadedProject } from "../helpers/loadedProject";

const CORNERS = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0)];

/**
 * A triangle bound to two bones under a scaled, moved armature, the mesh itself moved too - as a
 * GLB's armature node often is - with a clip turning the tip and one moving the mesh. Bound before
 * its world matrices are updated, it has an identity bind matrix, as GLTFLoader binds one.
 */
function rigged(boundBeforeWorld = false): { mesh: SkinnedMesh; clips: AnimationClip[] } {
  const geometry = new BufferGeometry();
  geometry.setFromPoints(CORNERS);
  geometry.setAttribute(
    "normal",
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
  );
  geometry.setAttribute(
    "skinIndex",
    new BufferAttribute(new Uint16Array([0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new BufferAttribute(new Float32Array([1, 0, 0, 0, 0.25, 0.75, 0, 0, 1, 0, 0, 0]), 4),
  );
  const scene = new Group();
  const armature = new Group();
  armature.position.set(1, 2, 3);
  armature.scale.setScalar(0.5);
  const root = new Bone();
  root.name = "root";
  const tip = new Bone();
  tip.name = "tip";
  tip.position.y = 2;
  root.add(tip);
  armature.add(root);
  const mesh = new SkinnedMesh(geometry);
  mesh.name = "arm";
  mesh.position.set(-1, 0, 2);
  scene.add(armature, mesh);
  scene.updateMatrixWorld(true);
  mesh.bind(new Skeleton([root, tip]), boundBeforeWorld ? new Matrix4() : undefined);
  const turn = new QuaternionKeyframeTrack("tip.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0.6, 0.8]);
  const away = new VectorKeyframeTrack("arm.position", [0, 1], [0, 0, 0, 5, 0, 0]);
  return {
    mesh,
    clips: [new AnimationClip("wave", 1, [turn, away]), new AnimationClip("slide", 1, [away])],
  };
}

/** Where `mesh`'s corners are skinned to with its tip bone turned, in its scene's space. */
function skinnedCorners(mesh: SkinnedMesh): Vector3[] {
  const tip = mesh.skeleton.bones.find((bone) => bone.name === "tip");
  tip?.rotation.set(0.3, 0, -0.7);
  (mesh.parent ?? mesh).updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute("position");
  return CORNERS.map((_, index) =>
    mesh
      .applyBoneTransform(index, new Vector3().fromBufferAttribute(position, index))
      .applyMatrix4(mesh.matrixWorld),
  );
}

describe("bakeMeshArrays / buildMesh", () => {
  it.each([false, true])(
    "rebuilds a skinned mesh that skins as the source draws, in its scene's space (bound before its world matrices: %s)",
    (boundBeforeWorld) => {
      const source = rigged(boundBeforeWorld);
      const baked = bakeMeshArrays(source.mesh, source.clips);
      const built = buildMesh(baked);
      expect(built.mesh).toBeInstanceOf(SkinnedMesh);
      const expected = skinnedCorners(source.mesh);
      skinnedCorners(built.mesh as SkinnedMesh).forEach((corner, index) => {
        expect(corner.distanceTo(expected[index])).toBeLessThan(1e-5);
      });
    },
  );

  it.each([false, true])(
    "keeps the geometry and the mesh's own space, so a posed point there is the source's (bound before its world matrices: %s)",
    (boundBeforeWorld) => {
      const source = rigged(boundBeforeWorld);
      const baked = bakeMeshArrays(source.mesh, source.clips);
      CORNERS.forEach((corner, index) => {
        expect(new Vector3().fromArray(baked.position, index * 3).distanceTo(corner)).toBe(0);
      });
      const built = buildMesh(baked).mesh as SkinnedMesh;
      skinnedCorners(built);
      skinnedCorners(source.mesh);
      CORNERS.forEach((corner, index) => {
        const own = (mesh: SkinnedMesh): Vector3 => mesh.applyBoneTransform(index, corner.clone());
        expect(own(built).distanceTo(own(source.mesh))).toBeLessThan(1e-5);
      });
    },
  );

  it("places a mesh without a skin as its file does", () => {
    const source = rigged();
    source.mesh.geometry.deleteAttribute("skinWeight");
    const built = buildMesh(bakeMeshArrays(source.mesh, source.clips));
    built.root.updateMatrixWorld(true);
    expect(built.mesh).not.toBeInstanceOf(SkinnedMesh);
    built.mesh.matrixWorld.elements.forEach((value, index) => {
      expect(value).toBeCloseTo(source.mesh.matrixWorld.elements[index] ?? NaN, 6);
    });
  });

  it("keeps the clips' tracks that move a bone, and drops a clip left with none", () => {
    const source = rigged();
    const { skin } = bakeMeshArrays(source.mesh, source.clips);
    expect(skin?.clips.map((clip) => clip.name)).toEqual(["wave"]);
    expect(skin?.clips[0]?.tracks.map((track) => track.name)).toEqual(["tip.quaternion"]);
    expect(buildMesh(bakeMeshArrays(source.mesh, source.clips)).clips[0]?.tracks).toHaveLength(1);
  });

  it("bakes no skin for a mesh without one", () => {
    const source = rigged();
    source.mesh.geometry.deleteAttribute("skinWeight");
    expect(bakeMeshArrays(source.mesh, source.clips).skin).toBeUndefined();
  });

  it("saves and loads the skin and the preview settings with the project", async () => {
    const source = rigged();
    const asset: MeshAsset = {
      name: "arm",
      label: "arm",
      geometry: bakeMeshArrays(source.mesh, source.clips),
      byteSize: 0,
      shownInScene: true,
      clip: "wave",
    };
    const text = await serializeProject(
      { ...createInitialState().source, meshAssets: [asset] },
      DEFAULT_VIEWPORT_VIEW,
    );
    const loaded = (await loadedProject(text))?.meshAssets[0];
    expect(loaded).toEqual(asset);
  });
});
