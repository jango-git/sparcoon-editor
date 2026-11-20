/**
 * Scene depth for Depth Fade and Depth Sample. The runtime reads depth per camera
 * (`fxSetCameraDepth`), so each camera gets a pre-pass before its frame, only while a shown effect
 * reads depth.
 */

import { fxSetCameraDepth } from "sparcoon";
import {
  type Camera,
  DepthTexture,
  type Object3D,
  type Scene,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";

import { drawnSize, sizedTarget, StudioDepth } from "./offscreenPass";

/** What the pre-pass asks of the previewed effects. */
export interface SceneDepthSource {
  /** The effects' root, left out of the pre-pass: the effects fade against the studio. */
  readonly effects: Object3D;
  /** Whether a shown effect reads scene depth, in a material or a GPU simulation. */
  readsSceneDepth(): boolean;
}

export class SceneDepthPass {
  public source: SceneDepthSource | undefined = undefined;

  private target: WebGLRenderTarget | undefined = undefined;
  private readonly size = new Vector2();
  private readonly studio: StudioDepth;
  // A depth texture needs WebGL2 or WEBGL_depth_texture; without one the effects draw hard.
  private readonly supported: boolean;

  constructor(
    private readonly renderer: WebGLRenderer,
    scene: Scene,
  ) {
    this.studio = new StudioDepth(renderer, scene);
    this.supported =
      renderer.capabilities.isWebGL2 || renderer.extensions.has("WEBGL_depth_texture");
  }

  /**
   * Gives `camera` the depth of its view of the studio, at the size of the target it is about to
   * draw into - or takes it away (and frees the target) while no shown effect reads it.
   */
  public update(camera: Camera): void {
    const source = this.source;
    if (!this.supported || source?.readsSceneDepth() !== true) {
      fxSetCameraDepth(camera, undefined);
      this.target?.dispose();
      this.target = undefined;
      return;
    }
    const drawn = this.renderer.getRenderTarget();
    const target = sizedTarget(
      this.target,
      drawnSize(this.renderer, this.size),
      (width, height) =>
        new WebGLRenderTarget(width, height, { depthTexture: new DepthTexture(width, height) }),
    );
    this.target = target;
    this.renderer.setRenderTarget(target);
    try {
      this.studio.draw(camera, source.effects);
    } finally {
      this.renderer.setRenderTarget(drawn);
    }
    fxSetCameraDepth(camera, target.depthTexture);
  }

  public dispose(): void {
    this.target?.dispose();
    this.target = undefined;
    this.studio.dispose();
  }
}
