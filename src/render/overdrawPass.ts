/**
 * The preview's overdraw view: how many effect layers are drawn over each pixel, shown as a heat
 * ramp in place of the shaded frame. The effects draw with a variant of each of their own materials
 * that adds one layer per fragment; the studio only occludes them.
 */

import {
  AddEquation,
  type Camera,
  Color,
  CustomBlending,
  type Material,
  Mesh,
  type Object3D,
  OneFactor,
  type Scene,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";

import { drawnSize, sizedTarget, StudioDepth, withoutFurniture } from "./offscreenPass";
import { OverdrawRamp } from "./overdrawRamp";
import { type OverdrawCount, overdrawFragmentShader } from "./overdrawShader";

/** The layer counts over a whole frame. A pixel holds at most 255 layers; more read as 255. */
export interface OverdrawStats {
  readonly width: number;
  readonly height: number;
  /** Fragments drawn over the frame: the sum of every pixel's layers. */
  readonly fragments: number;
  /** Pixels with at least one layer. */
  readonly covered: number;
  /** The most layers over one pixel. */
  readonly max: number;
}

/** What the overdraw view counts: the previewed effects. */
export interface OverdrawSource {
  /** The effects' root; everything else in the scene only hides what is behind it. */
  readonly effects: Object3D;
}

// `onBeforeRender` on a material: three calls it before every draw (r157 included), and
// `@types/three` 0.157 leaves it out. The runtime's Depth Fade binds the camera depth through it.
type DrawHooked = Material & { onBeforeRender?: unknown };

export class OverdrawPass {
  public source: OverdrawSource | undefined = undefined;

  private target: WebGLRenderTarget | undefined = undefined;
  private readonly size = new Vector2();
  private readonly studio: StudioDepth;
  private readonly ramp = new OverdrawRamp();
  // Per source material; `undefined` marks one whose shader takes no layer write (left as drawn).
  private readonly variants: Record<
    OverdrawCount,
    WeakMap<ShaderMaterial, ShaderMaterial | undefined>
  > = { rasterized: new WeakMap(), surviving: new WeakMap() };
  // The materials swapped out for one draw, restored right after it.
  private readonly swapped: [Mesh, Material][] = [];
  private readonly pixel = new Uint8Array(4);
  // The whole frame's counts for {@link stats}, kept while the frame size stays.
  private frame = new Uint8Array(0);
  private readonly clearColor = new Color();

  constructor(
    private readonly renderer: WebGLRenderer,
    scene: Scene,
  ) {
    this.studio = new StudioDepth(renderer, scene);
  }

  /** Draws `camera`'s overdraw into the current target (the canvas): {@link countLayers}, then the ramp. */
  public render(camera: Camera, count: OverdrawCount): void {
    this.ramp.draw(this.renderer, camera, this.countLayers(camera, count).texture);
  }

  /**
   * Counts `camera`'s layers into an offscreen target the size of the current one, read by
   * {@link countAt} and {@link stats}. The studio is drawn into that target's depth alone, so an
   * effect behind the ground counts nothing, as early-z drops it.
   */
  public countLayers(camera: Camera, count: OverdrawCount): WebGLRenderTarget {
    const drawn = this.renderer.getRenderTarget();
    this.target = sizedTarget(
      this.target,
      drawnSize(this.renderer, this.size),
      (width, height) => new WebGLRenderTarget(width, height),
    );
    const effects = this.source?.effects;
    const { autoClear } = this.renderer;
    const clearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.clearColor);
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 0);
    // Cleared once here: the studio's depth and the counts then add up in the one target.
    this.renderer.autoClear = false;
    try {
      this.renderer.clear();
      if (effects !== undefined) {
        this.studio.draw(camera, effects);
        this.drawCounts(camera, effects, count);
      }
    } finally {
      this.renderer.autoClear = autoClear;
      this.renderer.setRenderTarget(drawn);
      this.renderer.setClearColor(this.clearColor, clearAlpha);
    }
    return this.target;
  }

  /**
   * The layer count at drawing-buffer pixel (`x`, `y`), `y` down from the top, in the last
   * {@link countLayers}; `undefined` outside it or before one.
   */
  public countAt(x: number, y: number): number | undefined {
    const target = this.target;
    if (target === undefined || x < 0 || y < 0 || x >= target.width || y >= target.height) {
      return undefined;
    }
    this.renderer.readRenderTargetPixels(
      target,
      Math.floor(x),
      target.height - 1 - Math.floor(y),
      1,
      1,
      this.pixel,
    );
    return this.pixel[0];
  }

  /** Counts `camera`'s layers as {@link countLayers} does and sums them over the whole frame. */
  public measure(camera: Camera, count: OverdrawCount): OverdrawStats {
    const target = this.countLayers(camera, count);
    const { width, height } = target;
    if (this.frame.length !== width * height * 4) {
      this.frame = new Uint8Array(width * height * 4);
    }
    this.renderer.readRenderTargetPixels(target, 0, 0, width, height, this.frame);
    let fragments = 0;
    let covered = 0;
    let max = 0;
    for (let index = 0; index < this.frame.length; index += 4) {
      const layers = this.frame[index] ?? 0;
      fragments += layers;
      covered += layers > 0 ? 1 : 0;
      max = Math.max(max, layers);
    }
    return { width, height, fragments, covered, max };
  }

  /** Frees the counts target while the view is off; the material variants stay for the next use. */
  public release(): void {
    this.target?.dispose();
    this.target = undefined;
    this.frame = new Uint8Array(0);
  }

  public dispose(): void {
    this.release();
    this.studio.dispose();
    this.ramp.dispose();
  }

  /**
   * The effects alone, onto the studio's depth, each drawn with its overdraw variant. A root that
   * is no `Scene` draws without the background, the fog and the studio lights, none of which
   * change the count.
   */
  private drawCounts(camera: Camera, effects: Object3D, count: OverdrawCount): void {
    withoutFurniture(camera, () => {
      effects.traverseVisible((object) => {
        if (!(object instanceof Mesh) || !(object.material instanceof ShaderMaterial)) {
          return;
        }
        const variant = this.variantOf(object.material, count);
        if (variant !== undefined) {
          this.swapped.push([object, object.material]);
          object.material = variant;
        }
      });
      try {
        this.renderer.render(effects, camera);
      } finally {
        for (const [mesh, material] of this.swapped) {
          mesh.material = material;
        }
        this.swapped.length = 0;
      }
    });
  }

  private variantOf(source: ShaderMaterial, count: OverdrawCount): ShaderMaterial | undefined {
    const variants = this.variants[count];
    if (variants.has(source)) {
      return variants.get(source);
    }
    const variant = buildVariant(source, count);
    variants.set(source, variant);
    // A structural edit replaces and disposes the emitter's material; its variant goes with it.
    source.addEventListener("dispose", () => {
      variant?.dispose();
      variants.delete(source);
    });
    return variant;
  }
}

/**
 * The overdraw variant of an effect material: its own vertex stage and uniforms (the same objects,
 * so it moves and animates with the original, light slots aside), and the layer write summed by
 * additive blending. Built field by field rather than cloned: `clone` would copy the uniforms,
 * textures included.
 */
function buildVariant(source: ShaderMaterial, count: OverdrawCount): ShaderMaterial | undefined {
  const fragmentShader = overdrawFragmentShader(source.fragmentShader, count);
  if (fragmentShader === undefined) {
    return undefined;
  }
  const variant = new ShaderMaterial({
    name: `${source.name}Overdraw`,
    // A lit material's light slots are three's to fill per render, from the lights of what is
    // drawn: shared, the effects-only draw would leave the original's slots without its lights.
    uniforms: source.lights
      ? { ...source.uniforms, ...UniformsUtils.clone(UniformsLib.lights) }
      : source.uniforms,
    defines: { ...source.defines },
    vertexShader: source.vertexShader,
    fragmentShader,
    fog: source.fog,
    lights: source.lights,
    alphaHash: source.alphaHash,
    side: source.side,
    forceSinglePass: true,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
  });
  variant.extensions = { ...source.extensions };
  variant.glslVersion = source.glslVersion;
  const key = source.customProgramCacheKey();
  variant.customProgramCacheKey = (): string => `overdraw-${count}_${key}`;
  const hook = (source as DrawHooked).onBeforeRender;
  if (typeof hook === "function") {
    (variant as DrawHooked).onBeforeRender = hook;
  }
  return variant;
}
