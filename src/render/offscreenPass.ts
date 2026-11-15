/**
 * What the preview's offscreen passes (the scene depth, the overdraw view) share:
 * the studio drawn into depth alone, the editor's furniture left out of a draw, and a target kept
 * at the size of the frame it serves.
 */

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

/** Runs `draw` with the grid, player figure and gizmos off `camera`'s layers; the ground stays. */
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

/** The studio, effects left out, drawn into the current target's depth alone. */
export class StudioDepth {
  // Depth only: the studio's shading would be thrown away.
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

/** Writes into `out` the size of what `renderer` draws into now: its target, or the canvas. */
export function drawnSize(renderer: WebGLRenderer, out: Vector2): Vector2 {
  const drawn = renderer.getRenderTarget();
  return drawn instanceof WebGLRenderTarget
    ? out.set(drawn.width, drawn.height)
    : renderer.getDrawingBufferSize(out);
}

/**
 * `target` when it is already `size`, else a new one from `create` with `target` disposed. Remade,
 * not resized: a size change is rare, and a new target is plainly the right size.
 */
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
