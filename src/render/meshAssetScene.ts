/**
 * The mesh-asset library as live objects: each asset's geometry, which emitters draw and sample
 * as a shape, and its mesh in the preview scene, placed where its file places it, on the scene
 * layer, drawn when the asset is shown in the scene - the mesh of the scene emitters sample. A skinned mesh plays its clip at the timeline's time, and
 * the preview poses it every frame as a game poses the meshes it draws, shown or not: the skeleton
 * and, where the renderer reads float textures in vertex shaders, its bone texture.
 */

import {
  AnimationMixer,
  type BufferGeometry,
  type Mesh,
  MeshStandardMaterial,
  type Scene,
  SkinnedMesh,
  type Texture,
  type WebGLRenderer,
} from "three";

import { type MeshAsset, previewClipOf } from "../model/editorState";
import { markEditorScene } from "./editorOverlay";
import { LibraryCache } from "./libraryCache";
import { buildMesh, type BuiltMesh } from "./meshGeometryBaking";

/** One asset's mesh in the scene, which its settings change in place. */
class MeshAssetObject {
  private readonly material = new MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.8 });
  private readonly built: BuiltMesh;
  private readonly mixer: AnimationMixer;
  private clip: string | undefined;

  constructor(asset: MeshAsset, scene: Scene) {
    this.built = buildMesh(asset.geometry, this.material);
    this.mixer = new AnimationMixer(this.built.root);
    markEditorScene(this.built.root);
    scene.add(this.built.root);
  }

  public get mesh(): Mesh {
    return this.built.mesh;
  }

  public get skinnedMesh(): SkinnedMesh | undefined {
    const mesh = this.built.mesh;
    return mesh instanceof SkinnedMesh ? mesh : undefined;
  }

  public apply(asset: MeshAsset): void {
    const shown = asset.shownInScene === true;
    this.built.root.visible = shown;
    this.built.mesh.castShadow = shown;
    this.built.mesh.receiveShadow = shown;
    const name = previewClipOf(asset)?.name;
    const clip = this.built.clips.find((each) => each.name === name);
    if (clip?.name !== this.clip) {
      this.mixer.stopAllAction();
      if (clip !== undefined) {
        this.mixer.clipAction(clip).play();
      }
      this.clip = clip?.name;
    }
  }

  public pose(time: number, renderer: WebGLRenderer): void {
    const skeleton = this.skinnedMesh?.skeleton;
    if (skeleton === undefined) {
      this.built.root.updateMatrixWorld(true);
      return;
    }
    this.mixer.setTime(time);
    this.built.root.updateMatrixWorld(true);
    skeleton.update();
    if (renderer.capabilities.floatVertexTextures) {
      const texture = skeleton.boneTexture ?? skeleton.computeBoneTexture().boneTexture;
      renderer.initTexture(texture as Texture);
    }
  }

  public dispose(): void {
    this.mixer.stopAllAction();
    this.built.root.removeFromParent();
    this.built.mesh.geometry.dispose();
    this.material.dispose();
    this.skinnedMesh?.skeleton.dispose();
  }
}

export class MeshAssetScene {
  private readonly cache: LibraryCache<MeshAsset, MeshAssetObject>;

  constructor(
    scene: Scene,
    private readonly renderer: WebGLRenderer,
  ) {
    this.cache = new LibraryCache(
      (asset) => new MeshAssetObject(asset, scene),
      (object) => object.dispose(),
      (previous, next) => previous.geometry !== next.geometry,
    );
  }

  public sync(assets: readonly MeshAsset[]): void {
    this.cache.sync(assets);
    for (const asset of assets) {
      this.cache.get(asset.name)?.apply(asset);
    }
  }

  /** The geometries, by asset name. */
  public geometries(): Record<string, BufferGeometry> {
    const geometries: Record<string, BufferGeometry> = {};
    for (const [name, object] of Object.entries(this.cache.all())) {
      geometries[name] = object.mesh.geometry;
    }
    return geometries;
  }

  /** The meshes, skinned or not, by asset name - what a surface of the scene reads its pose
   *  from. */
  public meshes(): Record<string, Mesh> {
    const meshes: Record<string, Mesh> = {};
    for (const [name, object] of Object.entries(this.cache.all())) {
      meshes[name] = object.mesh;
    }
    return meshes;
  }

  /** Places every mesh, and poses every skinned mesh at `time` seconds of its clip, looping. */
  public pose(time: number): void {
    for (const object of Object.values(this.cache.all())) {
      object.pose(time, this.renderer);
    }
  }

  public destroy(): void {
    this.cache.destroy();
  }
}
