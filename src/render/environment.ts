/**
 * The neutral studio surroundings the emitters live in (ground, sun, ambient fill, background,
 * reference gizmos). Ambient fill is a live `HemisphereLight` in manual mode, or (ADR-0004) an
 * SH bake from the active HDRI - mutually exclusive, never both; Sun stays live either way.
 */

import {
  BackSide,
  BoxGeometry,
  Color,
  CubeCamera,
  type DataTexture,
  DirectionalLight,
  EdgesGeometry,
  GridHelper,
  HalfFloatType,
  HemisphereLight,
  LightProbe,
  LinearSRGBColorSpace,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
} from "three";
import { LightProbeGenerator } from "three/addons/lights/LightProbeGenerator.js";
import type { PreviewSettings } from "../settings/previewSettings";
import type { Rgba } from "../ui/components/color";
import type { DecodedEnvironment } from "./environmentTexture";

/** Y of the ground plane - shares the emitters' origin so particles rest on it, not above it. */
const GROUND_Y = 0;

/** Distance the sun sits from the origin; its azimuth/elevation place it on this sphere. */
const SUN_DISTANCE = 14;

/** Half-extent of the sun's orthographic shadow frustum (the shadow box). */
const SHADOW_BOX_HALF = 30;

/** Side length of the ground plane and grid. */
const GROUND_SIZE = 60;

/** Player-figure box dimensions (width x height x depth) - a standing scale reference. */
const PLAYER_SIZE: readonly [number, number, number] = [0.5, 2, 0.75];

/** Cube face resolution for the SH bake - tiny; the probe only needs low-frequency (band-2) detail. */
const BAKE_FACE_SIZE = 16;

export class SceneEnvironment {
  private readonly background = new Color();
  private readonly ground: Mesh;
  private readonly groundGeometry: PlaneGeometry;
  private readonly groundMaterial: MeshStandardMaterial;
  private readonly sun: DirectionalLight;
  // The manual sky/ground fill (no active environment): a live light, not baked (see the class doc).
  private readonly hemisphereLight: HemisphereLight;
  // The active-environment fill: an SH light probe baked from a texture-mapped dome.
  private readonly probe = new LightProbe();
  private readonly bakeScene = new Scene();
  private readonly bakeTarget = new WebGLCubeRenderTarget(BAKE_FACE_SIZE, { type: HalfFloatType });
  private readonly bakeCamera = new CubeCamera(0.1, 100, this.bakeTarget);
  private readonly domeGeometry = new SphereGeometry(5, 16, 12);
  private readonly domeMaterial = new MeshBasicMaterial({ side: BackSide });
  /** The environment texture last baked into {@link probe}, so an unchanged texture skips the bake. */
  private bakedTexture: DataTexture | undefined;
  private readonly grid: GridHelper;
  private readonly player: LineSegments;
  private readonly playerGeometry: EdgesGeometry;
  private readonly playerMaterial: LineBasicMaterial;

  constructor(
    private readonly scene: Scene,
    settings: PreviewSettings,
    activeEnvironment: DecodedEnvironment | undefined,
    private readonly renderer: WebGLRenderer,
  ) {
    scene.background = this.background;

    // Bake rig: the dome (map swapped to the active HDRI) rendered to a cube target and projected
    // to SH, only while an environment is active. Linear so the probe irradiance stays linear.
    this.bakeTarget.texture.colorSpace = LinearSRGBColorSpace;
    this.bakeScene.add(new Mesh(this.domeGeometry, this.domeMaterial));
    scene.add(this.probe);

    // Ground plane - lit, matte, and the surface that catches shadows. Kept a dark
    // neutral grey so the (unlit) grid lines drawn over it read as clearly lighter.
    this.groundGeometry = new PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
    this.groundMaterial = new MeshStandardMaterial({
      color: 0x2c2f36,
      roughness: 1,
      metalness: 0,
    });
    this.ground = new Mesh(this.groundGeometry, this.groundMaterial);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = GROUND_Y;
    this.ground.receiveShadow = true;
    scene.add(this.ground);

    // Sun - the key light. Its orthographic shadow camera is the shadow box; its
    // position is derived from the azimuth/elevation settings in `apply`.
    this.sun = new DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -SHADOW_BOX_HALF;
    this.sun.shadow.camera.right = SHADOW_BOX_HALF;
    this.sun.shadow.camera.top = SHADOW_BOX_HALF;
    this.sun.shadow.camera.bottom = -SHADOW_BOX_HALF;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 40;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemisphereLight = new HemisphereLight(0xffffff, 0x000000, 0);
    scene.add(this.hemisphereLight);

    // Grid overlaid just above the ground plane (a hair up to avoid z-fighting).
    // Bright cool centre lines with lighter-than-ground minor lines keep it legible.
    this.grid = new GridHelper(GROUND_SIZE, GROUND_SIZE, 0x9aa4b4, 0x565b66);
    this.grid.position.y = GROUND_Y + 0.01;
    scene.add(this.grid);

    // Player figure - a wireframe box resting on the ground as a scale reference.
    this.playerGeometry = new EdgesGeometry(new BoxGeometry(...PLAYER_SIZE));
    this.playerMaterial = new LineBasicMaterial({ color: 0x00e0a0 });
    this.player = new LineSegments(this.playerGeometry, this.playerMaterial);
    // Offset +1 on x so the figure stands clear of the emitter origin (task 4).
    this.player.position.set(1, GROUND_Y + PLAYER_SIZE[1] / 2, 0);
    scene.add(this.player);

    this.apply(settings, activeEnvironment);
  }

  /** Reflects settings (and the active environment, if any) onto the lights, gizmos and
   * background. An active environment fully replaces the manual Hemisphere fill (ADR-0004). */
  public apply(settings: PreviewSettings, activeEnvironment: DecodedEnvironment | undefined): void {
    this.sun.visible = settings.sun;
    setLinear(this.sun.color, settings.sunColor);
    this.sun.intensity = settings.sunIntensity;
    this.placeSun(settings.sunAzimuth, settings.sunElevation);

    if (activeEnvironment !== undefined) {
      this.hemisphereLight.visible = false;
      this.scene.background = activeEnvironment.background;
      this.probe.intensity = 1;
      this.bakeFromTexture(activeEnvironment.full);
    } else {
      setLinear(this.background, settings.background);
      this.scene.background = this.background;
      this.hemisphereLight.visible = settings.hemisphere;
      setLinear(this.hemisphereLight.color, settings.hemisphereSky);
      setLinear(this.hemisphereLight.groundColor, settings.hemisphereGround);
      this.hemisphereLight.intensity = settings.hemisphereIntensity;
      this.probe.intensity = 0;
      // Forces the next environment activation to rebake, even onto a texture already seen once.
      this.bakedTexture = undefined;
    }
    this.grid.visible = settings.grid;
    this.player.visible = settings.playerFigure;
  }

  public destroy(): void {
    this.scene.remove(
      this.ground,
      this.sun,
      this.sun.target,
      this.hemisphereLight,
      this.probe,
      this.grid,
      this.player,
    );
    this.groundGeometry.dispose();
    this.groundMaterial.dispose();
    this.sun.dispose();
    this.bakeTarget.dispose();
    this.domeGeometry.dispose();
    this.domeMaterial.dispose();
    this.grid.dispose();
    this.playerGeometry.dispose();
    this.playerMaterial.dispose();
  }

  /** Re-bakes the SH probe from `texture` when it has changed, so unrelated settings drags don't
   * pay the cube render + pixel readback again. */
  private bakeFromTexture(texture: DataTexture): void {
    if (this.bakedTexture === texture) {
      return;
    }
    this.domeMaterial.map = texture;
    this.domeMaterial.needsUpdate = true;
    // The cube render + pixel readback can throw on a lost/absent GL context; keep the last good
    // probe on failure. Commit only on success, so a transient failure retries next apply.
    try {
      this.bakeCamera.update(this.renderer, this.bakeScene);
      this.probe.sh.copy(
        LightProbeGenerator.fromCubeRenderTarget(this.renderer, this.bakeTarget).sh,
      );
      this.bakedTexture = texture;
    } catch {
      /* keep the previously baked probe */
    }
  }

  /** Places the sun on the shadow sphere from a compass azimuth and horizon elevation. */
  private placeSun(azimuthDegrees: number, elevationDegrees: number): void {
    const azimuth = (azimuthDegrees * Math.PI) / 180;
    const elevation = (elevationDegrees * Math.PI) / 180;
    const horizontal = SUN_DISTANCE * Math.cos(elevation);
    this.sun.position.set(
      horizontal * Math.sin(azimuth),
      SUN_DISTANCE * Math.sin(elevation),
      horizontal * Math.cos(azimuth),
    );
  }
}

/** Writes a linear RGBA (the editor's color model) onto a Three color, ignoring alpha. */
function setLinear(color: Color, rgba: Rgba): void {
  // Three's working color space is linear-sRGB, so `setRGB` takes our linear channels as-is.
  color.setRGB(rgba[0], rgba[1], rgba[2]);
}
