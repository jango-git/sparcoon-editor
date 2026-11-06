/**
 * The render coordinator: owns the Three renderer, scene, camera, orbit controls and frame loop. It
 * only reflects the model - it never writes to it.
 *
 * The canvas is opaque and shadow-mapped: it renders into the neutral studio `SceneEnvironment`
 * (ground, sun, SH light-probe fill) rather than showing the CSS stage through. Each frame ticks
 * every emitter and VFX mesh (via `FXWorld.update`), updates the orbit controls, then renders.
 */

import {
  Color,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGL1Renderer,
  WebGLRenderer,
  WebGLRenderTarget,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FXWorld } from "sparcoon";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import type { PreviewSettingsStore } from "../settings/previewSettings";
import { resetRenderBackend } from "../settings/renderBackend";
import { WheelDirectionLock } from "../ui/primitives/wheelDirectionLock";
import { EDITOR_OVERLAY_LAYER } from "./editorOverlay";
import { SceneEnvironment } from "./environment";
import type { DecodedEnvironment } from "./environmentTexture";

/**
 * Builds the preview's `WebGLRenderer`, forcing an actual WebGL1 context for the `baseline`
 * tier (`THREE.WebGL1Renderer` drops "webgl2" from three's own context-negotiation candidate
 * list) rather than letting three pick whatever the browser offers. If even a WebGL1 context
 * can't be created (a real device/browser limitation, not hypothetical - three's own constructor
 * throws synchronously in that case), fall back to the ordinary negotiated renderer and reset the
 * stored preference so the *next* reload doesn't repeat the same failure.
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

/** What one {@link SceneCoordinator.capture} renders. */
export interface FrameCaptureOptions {
  /** Pixel size to render at; omitted, the viewport's own drawing-buffer size. */
  readonly size?: { readonly width: number; readonly height: number };
  /** Whether the editor's furniture (ground, grid, player figure, gizmos) is drawn. Default true. */
  readonly overlays?: boolean;
  /** Replaces the background for this frame (an active HDRI's included); lighting is untouched. */
  readonly background?: Color | "transparent";
  /** Where the frame is shot from; omitted, the viewport camera's own view. */
  readonly view?: CaptureView;
}

/**
 * A capture-only point of view - the viewport camera and its orbit limits are left alone. `look`
 * places the camera outright; `frame` fits a sphere of `radius` around `object`, seen from the
 * viewport camera's current side of it, at any distance (no orbit clamp, so a 0.1-unit object
 * can fill the frame).
 */
export type CaptureView =
  | {
      readonly kind: "look";
      readonly position: Vector3;
      readonly target: Vector3;
      /** Vertical field of view in degrees; omitted, the viewport's. */
      readonly fov?: number;
    }
  | { readonly kind: "frame"; readonly object: Object3D; readonly radius: number };

export class SceneCoordinator {
  public readonly scene = new Scene();

  private readonly renderer: WebGLRenderer;
  private readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly environment: SceneEnvironment;
  private readonly settings: PreviewSettingsStore;
  /** The decoded active-environment textures (ADR-0004), set externally as the library resolves them. */
  private activeEnvironment: DecodedEnvironment | undefined;
  private readonly resizeObserver: ResizeObserver;
  private previousTimestamp: number | undefined;
  private running = false;
  private frameHandle: number | undefined;
  // In touchpad mode the wheel pans (two-finger scroll) / pinch-zooms; in mouse mode it dollies.
  // Either way {@link onWheel} owns the zoom (OrbitControls' wheel-zoom stays off); see {@link setTouchpad}.
  private touchpad = false;
  /** Guards mouse-mode wheel-dolly against a spurious single-notch direction flip. */
  private readonly wheelDirection = new WheelDirectionLock();
  // FPS is reported from a running average over a short window rather than each raw frame,
  // so the readout is legible instead of flickering; these accumulate that window.
  private statsFrames = 0;
  private statsElapsed = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    settings: PreviewSettingsStore,
    // Which GLSL tier (and, for `baseline`, which literal WebGL context version) the preview
    // renders with - a session-fixed choice (`settings/renderBackend.ts`), read once here.
    renderBackend: FXGLSLRenderTier,
    // Gates the simulation clock: the timeline transport drives it, so a stopped/paused
    // timeline freezes every emitter (see {@link frame}). Defaults to always-on.
    private readonly isSimulating: () => boolean = () => true,
    private readonly onStats?: (fps: number, particles: number) => void,
  ) {
    this.renderer = createSceneRenderer(canvas, renderBackend);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.camera = new PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 2, 7);
    // The viewport shows the editor's furniture too; a clean capture switches this layer off.
    this.camera.layers.enable(EDITOR_OVERLAY_LAYER);

    // Damping off so the camera stops exactly when the pointer does; polar clamp keeps it from
    // diving below the floor. Bound to the container (not the canvas) so a drag starting over a
    // viewport overlay still orbits - the overlays' interactive parts stopPropagation to opt out.
    this.controls = new OrbitControls(this.camera, container);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = false;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 30;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    // {@link onWheel} owns wheel-zoom in both modes (dolly in mouse mode, pan/pinch in touchpad),
    // so the mouse notch can run through the direction lock; OrbitControls only orbits and drag-pans.
    this.controls.enableZoom = false;
    this.controls.update();

    // Touchpad navigation: touchpad mode pans/pinch-zooms, mouse mode dollies - onWheel
    // drives both (OrbitControls' own wheel-zoom stays off). On the container so it works over overlays.
    container.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });

    this.settings = settings;
    this.environment = new SceneEnvironment(
      this.scene,
      settings.get(),
      this.activeEnvironment,
      this.renderer,
    );
    settings.subscribe((next) => this.environment.apply(next, this.activeEnvironment));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    // A backgrounded tab still fires (throttled) rAF callbacks, so without this the frame after
    // the tab regains visibility sees a huge raw timestamp gap and feeds it straight into
    // FXWorld.update as one giant simulation step - a burst of particles aged/spawned at once.
    // Halting the loop while hidden and resuming with a fresh timestamp anchor avoids both that
    // and any simulation progressing unseen in the background.
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  /** The preview camera - handed to emitters that opt into camera depth-sorting (render sink). */
  public getCamera(): PerspectiveCamera {
    return this.camera;
  }

  /** The live renderer - handed to emitters that opt into GPU (transform-feedback) simulation,
   *  so they can check `capabilities.isWebGL2` and construct the GPU driver against it. */
  public getRenderer(): WebGLRenderer {
    return this.renderer;
  }

  /** Wires the live particle-count source (the scene emitters), reported alongside FPS. */
  public setParticleCountSource(source: () => number): void {
    this.getParticleCount = source;
  }

  /**
   * Sets the decoded active-environment textures (ADR-0004), or `undefined` for manual lighting.
   * The composition root resolves this from the preview settings' active name against the content
   * library's decoded HDRI cache and calls this whenever either changes.
   */
  public setActiveEnvironment(environment: DecodedEnvironment | undefined): void {
    this.activeEnvironment = environment;
    this.environment.apply(this.settings.get(), environment);
  }

  /** Enables/disables orbit controls - the modal transform tool suspends them while it runs. */
  public setControlsEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  /**
   * Switches viewport navigation between mouse and touchpad. In touchpad mode a plain
   * two-finger scroll pans and a pinch (Ctrl+wheel) zooms; in mouse mode the wheel dollies. Either
   * way {@link onWheel} drives the zoom - OrbitControls' own wheel-zoom stays off (set in the ctor).
   */
  public setTouchpad(enabled: boolean): void {
    this.touchpad = enabled;
  }

  /**
   * Frames `object` in the viewport (the preview's `F` shortcut): re-aims the orbit target at the
   * object's world origin and dollies the camera - along its current viewing direction - to a
   * distance that fits a sphere of `radius`, clamped to the orbit distance limits.
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
   * Advances every emitter and VFX mesh by `deltaSeconds` of simulation time - the one place the
   * simulation clock is stepped, whether by the live frame loop or an offline capture driving
   * time itself (the agent API's deterministic snapshots).
   */
  public advance(deltaSeconds: number): void {
    FXWorld.update(deltaSeconds);
  }

  /**
   * Renders the scene once and returns a 2D-canvas copy of the frame, taken in the same task as
   * the render because the WebGL drawing buffer is not preserved past it. See
   * {@link FrameCaptureOptions} for size, overlays and background; whatever they change is
   * restored afterwards and the live view repainted. The copy is always the drawing buffer's real
   * size, which a GPU limit can clamp below the requested one; the frame is never stretched.
   */
  public capture(options: FrameCaptureOptions = {}): HTMLCanvasElement {
    const { size, overlays = true, background, view } = options;
    const pixelRatio = this.renderer.getPixelRatio();
    const viewportSize = this.renderer.getSize(new Vector2());
    const viewportBackground = this.scene.background;
    // Shot through a copy, so size, overlays and point of view never touch the viewport camera.
    const camera = this.camera.clone();
    try {
      if (size !== undefined) {
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(size.width, size.height, false);
        camera.aspect = size.width / size.height;
      }
      if (view !== undefined) {
        aimCaptureCamera(camera, view);
      }
      camera.updateProjectionMatrix();
      if (!overlays) {
        camera.layers.disable(EDITOR_OVERLAY_LAYER);
      }
      if (background === "transparent") {
        return this.renderTransparent(camera);
      }
      if (background !== undefined) {
        this.scene.background = background;
      }
      this.renderer.render(this.scene, camera);
      const canvas = this.renderer.domElement;
      return copyCanvas(canvas, canvas.width, canvas.height);
    } finally {
      this.scene.background = viewportBackground;
      if (size !== undefined) {
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.setSize(viewportSize.x, viewportSize.y, false);
      }
      this.renderer.render(this.scene, this.camera);
    }
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
    this.renderer.dispose();
  }

  // Function-valued field: eslint's member-ordering ranks this as a private method (not a
  // field), so it lives here with the other private methods rather than up in the field block.
  // Total alive particle count across the scene, sampled when stats are reported. The scene
  // emitters own this figure and wire it in via {@link setParticleCountSource}; 0 until then.
  private getParticleCount: () => number = () => 0;

  /** Wheel handler: touchpad pans/pinch-zooms; mouse dollies through the direction lock. */
  private onWheel(event: WheelEvent): void {
    if (!this.controls.enabled) {
      return; // a modal transform owns the pointer
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

  /** Dollies the camera toward/away from the orbit target by `scale`, clamped to the zoom limits. */
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
   * Pans the camera and its orbit target across the view plane by a screen-space delta (px),
   * scaled so the drag tracks the cursor at the current distance. Mirrors the graph's two-finger
   * scroll direction (the scene follows the fingers).
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

  /** Halts ticking while the tab is hidden, resuming with a fresh timestamp anchor once it is
   *  visible again - see the constructor's `visibilitychange` registration for why. */
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

    // The transport gates the simulation clock: a stopped/paused timeline advances no
    // emitter time (no spawn, no integration) while the camera and render stay live.
    this.advance(this.isSimulating() ? deltaSeconds : 0);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frameHandle = requestAnimationFrame((next) => this.frame(next));
  }

  /**
   * Accumulates frame timings and pushes a running-average FPS to {@link onStats} roughly
   * twice a second. The first frame's delta is 0 (no prior timestamp); that and any other
   * zero delta is skipped so it neither inflates the count nor divides by zero.
   */
  private reportFps(deltaSeconds: number): void {
    if (this.onStats === undefined || deltaSeconds <= 0) {
      return;
    }
    this.statsFrames += 1;
    this.statsElapsed += deltaSeconds;
    if (this.statsElapsed >= 0.5) {
      this.onStats(this.statsFrames / this.statsElapsed, this.getParticleCount());
      this.statsFrames = 0;
      this.statsElapsed = 0;
    }
  }

  /**
   * Renders into an offscreen target cleared to transparent (the canvas itself has no alpha) and
   * reads it back as a straight-alpha image. The runtime blends premultiplied and makes additive
   * light by lowering alpha, so a fully additive pixel carries color at alpha 0: a straight-alpha
   * image cannot hold it, and it comes out empty. A solid background keeps it.
   */
  private renderTransparent(camera: PerspectiveCamera): HTMLCanvasElement {
    const { x: width, y: height } = this.renderer.getDrawingBufferSize(new Vector2());
    const target = new WebGLRenderTarget(width, height, { samples: 4 });
    // Encode like the canvas does, so the two capture paths agree on color.
    target.texture.colorSpace = SRGBColorSpace;
    const previousTarget = this.renderer.getRenderTarget();
    const clearColor = this.renderer.getClearColor(new Color());
    const clearAlpha = this.renderer.getClearAlpha();
    // three's "no background" is `null`; its type admits nothing else, so the project's
    // no-null rule cannot apply to this third-party field.
    // eslint-disable-next-line no-restricted-syntax
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(target);
    try {
      this.renderer.render(this.scene, camera);
      const pixels = new Uint8Array(width * height * 4);
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      return straightAlphaCanvas(pixels, width, height);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setClearColor(clearColor, clearAlpha);
      target.dispose();
    }
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
    this.renderer.render(this.scene, this.camera);
  }
}

/** Margin around a framed sphere, so it does not touch the frame's edges. */
const FRAMING_MARGIN = 1.3;
/** The closest a capture camera's near plane comes in - keeps the depth range finite. */
const MIN_CAPTURE_NEAR = 1e-4;

/** `object`'s world-space origin, with its world matrix brought up to date first. */
function worldCenter(object: Object3D): Vector3 {
  object.updateWorldMatrix(true, false);
  return object.getWorldPosition(new Vector3());
}

/** The unit direction from `center` toward `camera` (a fixed side when they coincide). */
function viewDirection(camera: PerspectiveCamera, center: Vector3): Vector3 {
  const direction = camera.position.clone().sub(center);
  if (direction.lengthSq() < 1e-6) {
    direction.set(0, 2, 7);
  }
  return direction.normalize();
}

/** The camera distance at which a sphere of `radius` fills `camera`'s view, with a margin. */
function fitDistance(camera: PerspectiveCamera, radius: number): number {
  return (radius / Math.tan((camera.fov * Math.PI) / 360)) * FRAMING_MARGIN;
}

/**
 * Points a capture camera along `view`, pulling its near plane in for a close shot - the
 * viewport's fixed near plane would otherwise clip an object smaller than it.
 */
function aimCaptureCamera(camera: PerspectiveCamera, view: CaptureView): void {
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
}

/** A 2D-canvas copy of `source`'s current pixels at `width` x `height`. */
function copyCanvas(source: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = height;
  copy.getContext("2d")?.drawImage(source, 0, 0, width, height);
  return copy;
}

/** A canvas from premultiplied, bottom-up GL pixels: rows flipped, color divided by alpha. */
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
