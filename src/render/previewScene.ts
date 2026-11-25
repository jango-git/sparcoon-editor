/**
 * The scene drawn around the effect, on the scene layer: the studio ground, nothing, or an uploaded
 * scene. Scene depth and the sun's shadows include whatever it shows.
 */

import { Mesh, MeshStandardMaterial, type Object3D, PlaneGeometry, type Scene } from "three";

import { markEditorScene } from "./editorOverlay";

/** Ground plane Y, level with the emitter origin. */
export const GROUND_Y = 0;

/** Side length of the studio ground, and of the grid drawn over it. */
export const GROUND_SIZE = 60;

/** What the scene shows. An uploaded scene's root is owned by whoever decoded it. */
export type PreviewSceneContent =
  | { readonly kind: "studio" }
  | { readonly kind: "void" }
  | { readonly kind: "asset"; readonly root: Object3D };

export class PreviewScene {
  private readonly groundGeometry = new PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  private readonly groundMaterial = new MeshStandardMaterial({
    color: 0x2c2f36,
    roughness: 1,
    metalness: 0,
  });
  private readonly ground = new Mesh(this.groundGeometry, this.groundMaterial);
  private shown: Object3D | undefined;

  constructor(private readonly scene: Scene) {
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = GROUND_Y - 0.025;
    this.ground.receiveShadow = true;
    this.show({ kind: "studio" });
  }

  public get showsStudio(): boolean {
    return this.shown === this.ground;
  }

  public show(content: PreviewSceneContent): void {
    const next =
      content.kind === "studio" ? this.ground : content.kind === "asset" ? content.root : undefined;
    if (next === this.shown) {
      return;
    }
    if (this.shown !== undefined) {
      this.scene.remove(this.shown);
    }
    if (next !== undefined) {
      markEditorScene(next);
      this.scene.add(next);
    }
    this.shown = next;
  }

  public destroy(): void {
    if (this.shown !== undefined) {
      this.scene.remove(this.shown);
    }
    this.shown = undefined;
    this.groundGeometry.dispose();
    this.groundMaterial.dispose();
  }
}
