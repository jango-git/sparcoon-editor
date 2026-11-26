/**
 * Owns the renderer, scene, camera, orbit controls and frame loop. Each frame ticks every emitter
 * and VFX mesh via `FXWorld.update`, updates the controls and renders into the opaque,
 * shadow-mapped studio.
 */

import { FXWorld } from "sparcoon";
import {
  type Camera,
  Color,
  Fog,
  type Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGL1Renderer,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import type { PreviewSettings, PreviewSettingsStore } from "../settings/previewSettings";
import { resetRenderBackend } from "../settings/renderBackend";
import type { PreviewViewMode } from "../ui/previewViewMode";
import { WheelDirectionLock } from "../ui/primitives/wheelDirectionLock";
import { EDITOR_GIZMO_LAYER, EDITOR_OVERLAY_LAYER, EDITOR_SCENE_LAYER } from "./editorOverlay";
import { SceneEnvironment } from "./environment";
import type { DecodedEnvironment } from "./environmentTexture";
import { OverdrawPass, type OverdrawStats } from "./overdrawPass";
import type { OverdrawCount } from "./overdrawShader";
import { PreviewScene, type PreviewSceneContent } from "./previewScene";
import { SceneDepthPass, type SceneDepthSource } from "./sceneDepthPass";
import type { ParticleOverflow } from "./sceneEmitters";

/**
 * Builds the renderer. The `baseline` tier forces a real WebGL1 context (`WebGL1Renderer`). If that
 * fails, falls back to the negotiated renderer and resets the stored preference so the next reload
 * does not repeat the failure.
 */
function createSceneRenderer(
  canvas: HTMLCanvasElement,
  renderBackend: FXGLSLRenderTier,
): WebGLRenderer {
  if (renderBackend !== "baseline") {
    return new WebGLRenderer({ canvas, antialias: true });
  }
  try {
    return new WebGL1Renderer({ canvas, antialias: true });
  } catch (error) {
    console.warn(
      "Baseline render backend requested but this browser could not create a WebGL1 context; falling back to the default (standard) backend.",
      error,
    );
    resetRenderBackend();
    return new WebGLRenderer({ canvas, antialias: true });
  }
}

/** The viewport camera's place: its position, the point it orbits and looks at, its vertical fov. */
export interface ViewportView {
  readonly position: [number, number, number];
  readonly target: [number, number, number];
  readonly fov: number;
}

/** Where an offscreen shot is taken from and at what size; the viewport camera is left alone. */
export interface CaptureShot {
  readonly size?: { readonly width: number; readonly height: number };
  /** Where the frame is shot from; omitted, the viewport camera's own view. */
  readonly view?: CaptureView;
}

/** What one {@link SceneCoordinator.measureOverdraw} reports. */
export interface OverdrawMeasure {
  /** Every part drawn together, as the viewport's overdraw view counts them. */
  readonly total: OverdrawStats;
  /** Each part drawn alone, in the order given; a hidden part counts nothing. */
  readonly parts: readonly OverdrawStats[];
}

/** What one {@link SceneCoordinator.capture} renders. */
export interface FrameCaptureOptions extends CaptureShot {
  readonly overlays?: boolean;
  /**
   * Whether the scene around the effect is drawn - what shadows fall on and a Depth Fade fades
   * against. Default: on with the {@link overlays}, off without them. The studio ground drawn
   * without the overlays fades into a solid {@link background} past the point the frame is aimed
   * at, so no edge of the plane shows.
   */
  readonly scene?: boolean;
  /** Replaces the background for this frame (an active HDRI's included); lighting is untouched. */
  readonly background?: Color | "transparent";
}

/**
 * Capture view. `look` places the camera outright. `frame` fits a sphere of `radius` around
 * `object` from the viewport camera's side, with no orbit clamp.
 */
export type CaptureView =
  | {
      readonly kind: "look";
      readonly position: Vector3;
      readonly target: Vector3;
      readonly fov?: number;
    }
  | { readonly kind: "frame"; readonly object: Object3D; readonly radius: number };

export class SceneCoordinator {
  public readonly scene = new Scene();

  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly environment: SceneEnvironment;
  private readonly previewScene: PreviewScene;
  private readonly depthPass: SceneDepthPass;
  private readonly overdrawPass: OverdrawPass;
  private viewMode: PreviewViewMode = "shaded";
  private pointer: { x: number; y: number } | undefined = undefined;
  private reportOverdraw: ((layers: number | undefined) => void) | undefined = undefined;
  private readonly settings: PreviewSettingsStore;
  private activeEnvironment: DecodedEnvironment | undefined;
  private readonly resizeObserver: ResizeObserver;
  private previousTimestamp: number | undefined;
  private running = false;
  private frameHandle: number | undefined;
  // `onWheel` owns wheel zoom in both modes, so OrbitControls wheel zoom stays off. Touchpad pans
  // and pinch-zooms, mouse dollies.
  private touchpad = false;
  /** Guards mouse-mode wheel-dolly against a spurious single-notch direction flip. */
  private readonly wheelDirection = new WheelDirectionLock();
  // FPS is a running average over a short window. These fields accumulate it.
  private statsFrames = 0;
  private statsElapsed = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    settings: PreviewSettingsStore,
    renderBackend: FXGLSLRenderTier,
    // The transport gates the simulation clock. A stopped or paused timeline freezes emitters.
    private readonly isSimulating: () => boolean = () => true,
    private readonly onStats?: (
      fps: number,
      particles: number,
      overflow?: ParticleOverflow,
    ) => void,
  ) {
    this.renderer = createSceneRenderer(canvas, renderBackend);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.depthPass = new SceneDepthPass(this.renderer, this.scene);
    this.overdrawPass = new OverdrawPass(this.renderer, this.scene);

    this.camera = new PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 2, 7);
    // A clean capture switches the furniture layer off.
    this.camera.layers.enable(EDITOR_OVERLAY_LAYER);
    this.camera.layers.enable(EDITOR_SCENE_LAYER);

    // Damping off, so the camera stops with the pointer. Polar clamp keeps it above the floor.
    // Bound to the container so drags over overlays still orbit.
    this.controls = new OrbitControls(this.camera, container);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = false;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 30;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.enableZoom = false;
    this.controls.update();

    container.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    container.addEventListener("pointermove", (event) => this.trackPointer(event));
    container.addEventListener("pointerleave", () => {
      this.pointer = undefined;
    });

    this.settings = settings;
    this.previewScene = new PreviewScene(this.scene);
    this.environment = new SceneEnvironment(
      this.scene,
      settings.get(),
      this.activeEnvironment,
      this.renderer,
    );
    this.applyViewLayers(settings.get());
    settings.subscribe((next) => {
      this.environment.apply(next, this.activeEnvironment);
      this.applyViewLayers(next);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    // Hidden tabs still fire throttled rAF callbacks, and the first frame after returning would
    // simulate one huge step. Halt the loop while hidden and restart with a fresh timestamp anchor.
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  public getCamera(): PerspectiveCamera {
    return this.camera;
  }

  public getRenderer(): WebGLRenderer {
    return this.renderer;
  }

  public setAfterRender(callback: () => void): void {
    this.afterRender = callback;
  }

  public setParticleCountSource(source: () => number): void {
    this.getParticleCount = source;
  }

  public setSceneDepthSource(source: SceneDepthSource): void {
    this.depthPass.source = source;
    this.overdrawPass.source = source;
  }

  /**
   * Switches the viewport between the shaded frame and the overdraw view. Captures are always
   * shaded.
   */
  public setViewMode(mode: PreviewViewMode): void {
    this.viewMode = mode;
    if (mode === "shaded") {
      this.overdrawPass.release();
    }
    this.renderViewport();
  }

  public setOverdrawReadout(report: (layers: number | undefined) => void): void {
    this.reportOverdraw = report;
  }

  public setParticleOverflowSource(source: () => ParticleOverflow | undefined): void {
    this.getParticleOverflow = source;
  }

  /** Sets the active environment textures, or `undefined` for manual lighting. */
  public setActiveEnvironment(environment: DecodedEnvironment | undefined): void {
    this.activeEnvironment = environment;
    this.environment.apply(this.settings.get(), environment);
  }

  /** Sets what the scene around the effect shows. */
  public setPreviewScene(content: PreviewSceneContent): void {
    this.previewScene.show(content);
  }

  public setControlsEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  /**
   * Switches navigation between mouse and touchpad. In touchpad mode two-finger scroll pans and
   * Ctrl+wheel zooms. In mouse mode the wheel dollies.
   */
  public setTouchpad(enabled: boolean): void {
    this.touchpad = enabled;
  }

  /** The viewport camera: where it is, the point it orbits and looks at, its vertical fov in degrees. */
  public getView(): ViewportView {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      fov: this.camera.fov,
    };
  }

  /**
   * Places the viewport camera at `position`, orbiting and looking at `target`, held to the orbit's
   * distance and height limits. The vertical `fov` (degrees) changes only when given.
   */
  public setView(view: {
    readonly position: Vector3;
    readonly target: Vector3;
    readonly fov?: number;
  }): void {
    this.controls.target.copy(view.target);
    this.camera.position.copy(view.position);
    if (view.fov !== undefined) {
      this.camera.fov = view.fov;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  /**
   * Aims the orbit target at the object's world origin and dollies along the view direction to fit
   * a sphere of `radius`, within the distance limits.
   */
  public focusOn(object: Object3D, radius: number): void {
    const center = worldCenter(object);
    this.controls.target.copy(center);
    const distance = Math.min(
      Math.max(fitDistance(this.camera, radius), this.controls.minDistance),
      this.controls.maxDistance,
    );
    this.camera.position.copy(center).addScaledVector(viewDirection(this.camera, center), distance);
    this.controls.update();
  }

  /**
   * Advances every emitter and VFX mesh by `deltaSeconds`. The only place the simulation clock
   * steps, for the frame loop and for offline capture.
   */
  public advance(deltaSeconds: number): void {
    FXWorld.update(deltaSeconds);
  }

  /**
   * Renders once and returns a 2D-canvas copy, copied in the same task because the drawing buffer
   * is not preserved. Options changed for the shot are restored and the view repainted. The copy
   * has the drawing buffer's real size, which a GPU limit may clamp below the request.
   */
  public capture(options: FrameCaptureOptions = {}): HTMLCanvasElement {
    return this.shoot(options, (camera, target) => this.captureFrom(camera, target, options));
  }

  /**
   * Counts overdraw for `shot`, all parts together and then each of `parts` alone. Part counts sum
   * to the total wherever no pixel reaches 255.
   */
  public measureOverdraw(
    count: OverdrawCount,
    shot: CaptureShot,
    parts: readonly Object3D[],
  ): OverdrawMeasure {
    return this.shoot(shot, (camera) => {
      this.depthPass.update(camera);
      const total = this.overdrawPass.measure(camera, count);
      const shown = parts.filter((part) => part.visible);
      try {
        return {
          total,
          parts: parts.map((part) => {
            for (const other of shown) {
              other.visible = other === part;
            }
            return this.overdrawPass.measure(camera, count);
          }),
        };
      } finally {
        for (const part of shown) {
          part.visible = true;
        }
      }
    });
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.frameHandle = requestAnimationFrame((timestamp) => this.frame(timestamp));
  }

  public destroy(): void {
    this.running = false;
    if (this.frameHandle !== undefined) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = undefined;
    }
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.environment.destroy();
    this.previewScene.destroy();
    this.depthPass.dispose();
    this.overdrawPass.dispose();
    this.renderer.dispose();
  }

  // Alive particle count across the scene, 0 until wired.
  private getParticleCount: () => number = () => 0;
  // Births lost to full emitters, sampled alongside the particle count; `undefined` = unknown.
  private getParticleOverflow: () => ParticleOverflow | undefined = () => undefined;
  private afterRender: () => void = () => undefined;

  private applyViewLayers(settings: PreviewSettings): void {
    if (settings.gizmos) {
      this.camera.layers.enable(EDITOR_GIZMO_LAYER);
    } else {
      this.camera.layers.disable(EDITOR_GIZMO_LAYER);
    }
  }

  private onWheel(event: WheelEvent): void {
    if (!this.controls.enabled) {
      return;
    }
    event.preventDefault();
    if (this.touchpad) {
      if (event.ctrlKey) {
        this.dollyBy(Math.exp(event.deltaY * 0.01));
      } else {
        this.panByPixels(event.deltaX, event.deltaY);
      }
      return;
    }
    // Mouse mode: a stray reverse notch is forced back to the run's direction before it dollies,
    // so a jittery wheel can't flip zoom-in to zoom-out mid-gesture.
    const deltaY = this.wheelDirection.resolve(event.deltaY, event.timeStamp);
    this.dollyBy(deltaY < 0 ? 1 / 1.1 : 1.1);
  }

  private dollyBy(scale: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = Math.min(
      Math.max(offset.length() * scale, this.controls.minDistance),
      this.controls.maxDistance,
    );
    offset.setLength(distance);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  /**
   * Pans the camera and orbit target across the view plane by a pixel delta, scaled to track the
   * cursor at the current distance.
   */
  private panByPixels(deltaX: number, deltaY: number): void {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const height = this.container.clientHeight || 1;
    const worldPerPixel = (2 * distance * Math.tan((this.camera.fov * Math.PI) / 360)) / height;
    const right = new Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const move = right
      .multiplyScalar(deltaX * worldPerPixel)
      .add(up.multiplyScalar(-deltaY * worldPerPixel));
    this.camera.position.add(move);
    this.controls.target.add(move);
    this.controls.update();
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) {
      if (this.frameHandle !== undefined) {
        cancelAnimationFrame(this.frameHandle);
        this.frameHandle = undefined;
      }
      return;
    }
    if (this.running && this.frameHandle === undefined) {
      this.previousTimestamp = undefined;
      this.frameHandle = requestAnimationFrame((timestamp) => this.frame(timestamp));
    }
  };

  private frame(timestamp: number): void {
    if (!this.running) {
      return;
    }
    const deltaSeconds =
      this.previousTimestamp === undefined ? 0 : (timestamp - this.previousTimestamp) / 1000;
    this.previousTimestamp = timestamp;
    this.reportFps(deltaSeconds);

    this.advance(this.isSimulating() ? deltaSeconds : 0);
    this.controls.update();
    this.renderViewport();
    this.afterRender();
    this.frameHandle = requestAnimationFrame((next) => this.frame(next));
  }

  /**
   * Reports average FPS about twice a second. Zero deltas (the first frame included) are skipped.
   */
  private reportFps(deltaSeconds: number): void {
    if (this.onStats === undefined || deltaSeconds <= 0) {
      return;
    }
    this.statsFrames += 1;
    this.statsElapsed += deltaSeconds;
    if (this.statsElapsed >= 0.5) {
      this.onStats(
        this.statsFrames / this.statsElapsed,
        this.getParticleCount(),
        this.getParticleOverflow(),
      );
      this.statsFrames = 0;
      this.statsElapsed = 0;
    }
  }

  private shoot<T>(shot: CaptureShot, draw: (camera: PerspectiveCamera, target: Vector3) => T): T {
    const { size, view } = shot;
    const pixelRatio = this.renderer.getPixelRatio();
    const viewportSize = this.renderer.getSize(new Vector2());
    const camera = this.camera.clone();
    try {
      if (size !== undefined) {
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(size.width, size.height, false);
        camera.aspect = size.width / size.height;
      }
      const target = view === undefined ? this.controls.target : aimCaptureCamera(camera, view);
      camera.updateProjectionMatrix();
      return draw(camera, target);
    } finally {
      if (size !== undefined) {
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.setSize(viewportSize.x, viewportSize.y, false);
      }
      this.renderViewport();
    }
  }

  private captureFrom(
    camera: PerspectiveCamera,
    target: Vector3,
    options: FrameCaptureOptions,
  ): HTMLCanvasElement {
    const { overlays = true, background } = options;
    const drawScene = options.scene ?? overlays;
    const viewportBackground = this.scene.background;
    const viewportFog = this.scene.fog;
    try {
      if (!overlays) {
        camera.layers.disable(EDITOR_OVERLAY_LAYER);
        camera.layers.disable(EDITOR_GIZMO_LAYER);
      }
      if (drawScene) {
        camera.layers.enable(EDITOR_SCENE_LAYER);
      } else {
        camera.layers.disable(EDITOR_SCENE_LAYER);
      }
      if (background === "transparent") {
        return this.renderTransparent(camera);
      }
      if (background !== undefined) {
        this.scene.background = background;
      }
      if (drawScene && this.previewScene.showsStudio && !overlays && background instanceof Color) {
        // Clear of the effect round the target, gone into the background well before the edge.
        const distance = camera.position.distanceTo(target);
        this.scene.fog = new Fog(
          background,
          distance * GROUND_FADE_START,
          distance * GROUND_FADE_END,
        );
      }
      this.renderFrom(camera);
      const canvas = this.renderer.domElement;
      return copyCanvas(canvas, canvas.width, canvas.height);
    } finally {
      this.scene.background = viewportBackground;
      this.scene.fog = viewportFog;
    }
  }

  /**
   * Renders offscreen and reads back straight-alpha. Additive pixels carry color at alpha 0 and
   * come out empty, so a solid background is needed to keep them.
   */
  private renderTransparent(camera: PerspectiveCamera): HTMLCanvasElement {
    const { x: width, y: height } = this.renderer.getDrawingBufferSize(new Vector2());
    const target = new WebGLRenderTarget(width, height, { samples: 4 });
    target.texture.colorSpace = SRGBColorSpace;
    const previousTarget = this.renderer.getRenderTarget();
    const clearColor = this.renderer.getClearColor(new Color());
    const clearAlpha = this.renderer.getClearAlpha();
    // three's "no background" is `null`.
    // eslint-disable-next-line no-restricted-syntax
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(target);
    try {
      this.renderFrom(camera);
      const pixels = new Uint8Array(width * height * 4);
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      return straightAlphaCanvas(pixels, width, height);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setClearColor(clearColor, clearAlpha);
      target.dispose();
    }
  }

  private renderFrom(camera: Camera): void {
    this.depthPass.update(camera);
    this.renderer.render(this.scene, camera);
  }

  private renderViewport(): void {
    if (this.viewMode === "shaded") {
      this.renderFrom(this.camera);
      return;
    }
    this.depthPass.update(this.camera);
    this.overdrawPass.render(this.camera, this.viewMode);
    if (this.reportOverdraw !== undefined) {
      const pointer = this.pointer;
      this.reportOverdraw(
        pointer === undefined ? undefined : this.overdrawPass.countAt(pointer.x, pointer.y),
      );
    }
  }

  private trackPointer(event: PointerEvent): void {
    const canvas = this.renderer.domElement;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) {
      return;
    }
    this.pointer = {
      x: ((event.clientX - bounds.left) * canvas.width) / bounds.width,
      y: ((event.clientY - bounds.top) * canvas.height) / bounds.height,
    };
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Paint immediately: a ResizeObserver can fire while the rAF loop is throttled (a background
    // tab, or before start()), which would otherwise leave the canvas stretched until the next tick.
    this.renderViewport();
  }
}

const FRAMING_MARGIN = 1.3;
const MIN_CAPTURE_NEAR = 1e-4;

function worldCenter(object: Object3D): Vector3 {
  object.updateWorldMatrix(true, false);
  return object.getWorldPosition(new Vector3());
}

function viewDirection(camera: PerspectiveCamera, center: Vector3): Vector3 {
  const direction = camera.position.clone().sub(center);
  if (direction.lengthSq() < 1e-6) {
    direction.set(0, 2, 7);
  }
  return direction.normalize();
}

function fitDistance(camera: PerspectiveCamera, radius: number): number {
  return (radius / Math.tan((camera.fov * Math.PI) / 360)) * FRAMING_MARGIN;
}

/** Where a clean frame's ground starts and ends fading into its background, as multiples of the
 *  camera's distance to what it is aimed at. */
const GROUND_FADE_START = 1.2;
const GROUND_FADE_END = 2.4;

/**
 * Aims `camera` along `view`, pulling the near plane in for a close shot (the fixed near plane
 * would clip a small object). Returns the aim point.
 */
function aimCaptureCamera(camera: PerspectiveCamera, view: CaptureView): Vector3 {
  let target: Vector3;
  if (view.kind === "look") {
    if (view.fov !== undefined) {
      camera.fov = view.fov;
    }
    camera.position.copy(view.position);
    target = view.target;
  } else {
    target = worldCenter(view.object);
    camera.position
      .copy(target)
      .addScaledVector(viewDirection(camera, target), fitDistance(camera, view.radius));
  }
  camera.lookAt(target);
  camera.near = Math.min(
    camera.near,
    Math.max(MIN_CAPTURE_NEAR, camera.position.distanceTo(target) / 100),
  );
  return target;
}

function copyCanvas(source: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = height;
  copy.getContext("2d")?.drawImage(source, 0, 0, width, height);
  return copy;
}

/**
 * Converts premultiplied, bottom-up GL pixels to a canvas. Flips rows and divides color by alpha.
 */
function straightAlphaCanvas(pixels: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d") ?? undefined;
  if (context === undefined) {
    return canvas;
  }
  const image = context.createImageData(width, height);
  for (let row = 0; row < height; row += 1) {
    const sourceRow = (height - 1 - row) * width * 4;
    const targetRow = row * width * 4;
    for (let offset = 0; offset < width * 4; offset += 4) {
      const alpha = pixels[sourceRow + offset + 3] ?? 0;
      const scale = alpha > 0 ? 255 / alpha : 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = pixels[sourceRow + offset + channel] ?? 0;
        image.data[targetRow + offset + channel] = Math.min(255, Math.round(value * scale));
      }
      image.data[targetRow + offset + 3] = alpha;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}
