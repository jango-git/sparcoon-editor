/** Helpers shared by the scene depth and overdraw passes. */

import {
  type Camera,
  MeshBasicMaterial,
  type Object3D,
  type Scene,
  type Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";

import { EDITOR_GIZMO_LAYER, EDITOR_OVERLAY_LAYER } from "./editorOverlay";

export function withoutFurniture(camera: Camera, draw: () => void): void {
  const layers = camera.layers.mask;
  camera.layers.disable(EDITOR_OVERLAY_LAYER);
  camera.layers.disable(EDITOR_GIZMO_LAYER);
  try {
    draw();
  } finally {
    camera.layers.mask = layers;
  }
}

export class StudioDepth {
  private readonly material = new MeshBasicMaterial({ colorWrite: false });

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
  ) {}

  public draw(camera: Camera, effects: Object3D): void {
    const { background, overrideMaterial } = this.scene;
    const { autoUpdate } = this.renderer.shadowMap;
    const effectsVisible = effects.visible;
    // three's "no background" is `null`; its type admits nothing else.
    // eslint-disable-next-line no-restricted-syntax
    this.scene.background = null;
    this.scene.overrideMaterial = this.material;
    // The frame's own render updates the shadow maps; this one would only redo them.
    this.renderer.shadowMap.autoUpdate = false;
    effects.visible = false;
    try {
      withoutFurniture(camera, () => this.renderer.render(this.scene, camera));
    } finally {
      effects.visible = effectsVisible;
      this.renderer.shadowMap.autoUpdate = autoUpdate;
      this.scene.overrideMaterial = overrideMaterial;
      this.scene.background = background;
    }
  }

  public dispose(): void {
    this.material.dispose();
  }
}

export function drawnSize(renderer: WebGLRenderer, out: Vector2): Vector2 {
  const drawn = renderer.getRenderTarget();
  return drawn instanceof WebGLRenderTarget
    ? out.set(drawn.width, drawn.height)
    : renderer.getDrawingBufferSize(out);
}

/** Returns `target` if it already has `size`, else a new target (the old one is disposed). */
export function sizedTarget(
  target: WebGLRenderTarget | undefined,
  size: Vector2,
  create: (width: number, height: number) => WebGLRenderTarget,
): WebGLRenderTarget {
  if (target?.width === size.x && target.height === size.y) {
    return target;
  }
  target?.dispose();
  return create(size.x, size.y);
}
