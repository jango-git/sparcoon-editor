/**
 * The preview's scene depth: what a Depth Fade in the previewed effects fades against. The runtime
 * reads depth per camera (`fxSetCameraDepth`), so each camera the preview draws from gets its own
 * pre-pass, rendered just before its frame - and only while some shown effect reads it.
 */

import { fxSetCameraDepth } from "sparcoon";
import {
  type Camera,
  DepthTexture,
  MeshBasicMaterial,
  type Object3D,
  type Scene,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";

/** What the pre-pass asks of the previewed effects. */
export interface SceneDepthSource {
  /** The effects' root, left out of the pre-pass: the effects fade against the studio. */
  readonly effects: Object3D;
  /** Whether a shown effect reads the scene depth; no pre-pass is paid otherwise. */
  readsSceneDepth(): boolean;
}

export class SceneDepthPass {
  public source: SceneDepthSource | undefined = undefined;

  private target: WebGLRenderTarget | undefined = undefined;
  private readonly size = new Vector2();
  // Depth only: the studio's shading would be thrown away.
  private readonly depthOnly = new MeshBasicMaterial({ colorWrite: false });
  // A depth texture needs WebGL2 or WEBGL_depth_texture; without one the effects draw hard.
  private readonly supported: boolean;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
  ) {
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
    if (drawn instanceof WebGLRenderTarget) {
      this.size.set(drawn.width, drawn.height);
    } else {
      this.renderer.getDrawingBufferSize(this.size);
    }
    const target = this.targetSized(this.size.x, this.size.y);

    const { overrideMaterial } = this.scene;
    const { autoUpdate } = this.renderer.shadowMap;
    const effectsVisible = source.effects.visible;
    this.scene.overrideMaterial = this.depthOnly;
    // The frame's own render updates the shadow maps; this one would only redo them.
    this.renderer.shadowMap.autoUpdate = false;
    const { effects } = source;
    effects.visible = false;
    this.renderer.setRenderTarget(target);
    try {
      this.renderer.render(this.scene, camera);
    } finally {
      this.renderer.setRenderTarget(drawn);
      effects.visible = effectsVisible;
      this.renderer.shadowMap.autoUpdate = autoUpdate;
      this.scene.overrideMaterial = overrideMaterial;
    }
    fxSetCameraDepth(camera, target.depthTexture);
  }

  public dispose(): void {
    this.target?.dispose();
    this.target = undefined;
    this.depthOnly.dispose();
  }

  // Remade, not resized, on a size change: rare, and a new depth texture is plainly the right size.
  private targetSized(width: number, height: number): WebGLRenderTarget {
    if (this.target?.width === width && this.target.height === height) {
      return this.target;
    }
    this.target?.dispose();
    this.target = new WebGLRenderTarget(width, height, {
      depthTexture: new DepthTexture(width, height),
    });
    return this.target;
  }
}
