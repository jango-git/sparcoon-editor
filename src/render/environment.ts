/**
 * The neutral studio surroundings the emitters live in (ground, sun, ambient fill, background,
 * reference gizmos). Ambient fill is a live `HemisphereLight` in manual mode, or (ADR-0004) an
 * SH bake from the active HDRI - mutually exclusive, never both; Sun stays live either way.
 */

import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  Color,
  CubeCamera,
  type DataTexture,
  DirectionalLight,
  EdgesGeometry,
  Float32BufferAttribute,
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
  Vector3,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
} from "three";
import { LightProbeGenerator } from "three/addons/lights/LightProbeGenerator.js";

import type { PreviewSettings } from "../settings/previewSettings";
import type { Rgba } from "../ui/components/color";
import { AXIS_COLORS } from "./axisColors";
import { markEditorGizmo, markEditorGround, markEditorOverlay } from "./editorOverlay";
import type { DecodedEnvironment } from "./environmentTexture";

/** Y of the ground plane - shares the emitters' origin so particles rest on it, not above it. */
const GROUND_Y = 0;

/** Distance the sun sits from the origin; its azimuth/elevation place it on this sphere. */
const SUN_DISTANCE = 14;

/** Distance from the origin the sun's gizmo sits at, along the sun's direction - near enough to
 *  stay in view, unlike the light itself. */
const SUN_GIZMO_DISTANCE = 3;

/** Sun gizmo: disc radius, ray length beyond the disc, and the line toward the lit scene. */
const SUN_GIZMO_RADIUS = 0.12;
const SUN_GIZMO_RAY = 0.08;
const SUN_GIZMO_BEAM = 0.9;

/** Sun gizmo color: a warm yellow, apart from the grey object outlines. */
const SUN_GIZMO_COLOR = 0xffd24a;

/** Half-extent of the sun's orthographic shadow frustum (the shadow box). */
const SHADOW_BOX_HALF = 30;

/** Side length of the ground plane and grid. */
const GROUND_SIZE = 60;

/** Player-figure box dimensions (width x height x depth) - a standing scale reference. */
const PLAYER_SIZE: readonly [number, number, number] = [0.5, 2, 0.75];

/** Cube face resolution for the SH bake - tiny; the probe only needs low-frequency (band-2) detail. */
const BAKE_FACE_SIZE = 16;

/** Grid color for every line that is not an axis - lighter than the ground, so the cells read. */
const GRID_MINOR_COLOR = 0x565b66;

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
  private readonly grid: LineSegments;
  private readonly gridGeometry: BufferGeometry;
  private readonly gridMaterial: LineBasicMaterial;
  private readonly player: LineSegments;
  private readonly playerGeometry: EdgesGeometry;
  private readonly playerMaterial: LineBasicMaterial;
  private readonly sunGizmo: LineSegments;
  private readonly sunGizmoGeometry: BufferGeometry;
  private readonly sunGizmoMaterial: LineBasicMaterial;

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
    this.ground.position.y = GROUND_Y - 0.025;
    this.ground.receiveShadow = true;
    markEditorGround(this.ground);
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

    // Grid overlaid just above the ground plane (a hair up to avoid z-fighting). Tone mapping is
    // off so the axis lines keep the literal color the gizmos use, whatever the exposure.
    this.gridGeometry = createGridGeometry(GROUND_SIZE, GROUND_SIZE);
    this.gridMaterial = new LineBasicMaterial({ vertexColors: true, toneMapped: false });
    this.grid = new LineSegments(this.gridGeometry, this.gridMaterial);
    this.grid.position.y = GROUND_Y + 0.01;
    markEditorOverlay(this.grid);
    scene.add(this.grid);

    // Player figure - a wireframe box resting on the ground as a scale reference.
    this.playerGeometry = new EdgesGeometry(new BoxGeometry(...PLAYER_SIZE));
    this.playerMaterial = new LineBasicMaterial({ color: 0x00e0a0 });
    this.player = new LineSegments(this.playerGeometry, this.playerMaterial);
    // Offset +1 on x so the figure stands clear of the emitter origin.
    this.player.position.set(1, GROUND_Y + PLAYER_SIZE[1] / 2, 0);
    markEditorOverlay(this.player);
    scene.add(this.player);

    // Sun gizmo - a rayed disc on the sun's side of the scene, its beam pointing the way the light
    // shines. Shown with the sun; the gizmo layer hides it with the object outlines.
    this.sunGizmoGeometry = createSunGizmoGeometry();
    this.sunGizmoMaterial = new LineBasicMaterial({ color: SUN_GIZMO_COLOR, toneMapped: false });
    this.sunGizmo = new LineSegments(this.sunGizmoGeometry, this.sunGizmoMaterial);
    this.sunGizmo.name = "SunGizmo";
    markEditorGizmo(this.sunGizmo);
    scene.add(this.sunGizmo);

    this.apply(settings, activeEnvironment);
  }

  /** Reflects settings (and the active environment, if any) onto the lights, gizmos and
   * background. An active environment fully replaces the manual Hemisphere fill (ADR-0004). */
  public apply(settings: PreviewSettings, activeEnvironment: DecodedEnvironment | undefined): void {
    this.sun.visible = settings.sun;
    this.sunGizmo.visible = settings.sun;
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
      this.sunGizmo,
    );
    this.groundGeometry.dispose();
    this.groundMaterial.dispose();
    this.sun.dispose();
    this.bakeTarget.dispose();
    this.domeGeometry.dispose();
    this.domeMaterial.dispose();
    this.gridGeometry.dispose();
    this.gridMaterial.dispose();
    this.playerGeometry.dispose();
    this.playerMaterial.dispose();
    this.sunGizmoGeometry.dispose();
    this.sunGizmoMaterial.dispose();
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
    const direction = new Vector3(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    );
    this.sun.position.copy(direction).multiplyScalar(SUN_DISTANCE);
    this.sunGizmo.position.copy(direction).multiplyScalar(SUN_GIZMO_DISTANCE);
    this.sunGizmo.lookAt(this.sun.target.position);
  }
}

/**
 * The ground grid as one line-segment geometry, `divisions` cells per side. Colors are per-vertex
 * so the two lines through the origin can wear their axis colors without a second draw call.
 */
function createGridGeometry(size: number, divisions: number): BufferGeometry {
  const half = size / 2;
  const step = size / divisions;
  // Only an even division count puts a line on the axes; an odd one straddles the origin.
  const centerIndex = divisions % 2 === 0 ? divisions / 2 : -1;
  const minor = new Color(GRID_MINOR_COLOR);
  const axisX = new Color(AXIS_COLORS[0]);
  const axisZ = new Color(AXIS_COLORS[2]);
  const positions: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i <= divisions; i += 1) {
    const offset = -half + i * step;
    // Two lines per step: one running along X (at z = offset), one along Z (at x = offset).
    positions.push(-half, 0, offset, half, 0, offset, offset, 0, -half, offset, 0, half);
    const alongX = i === centerIndex ? axisX : minor;
    const alongZ = i === centerIndex ? axisZ : minor;
    colors.push(...alongX.toArray(), ...alongX.toArray(), ...alongZ.toArray(), ...alongZ.toArray());
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

/**
 * The sun gizmo as one line-segment geometry: a disc with eight short rays in the XY plane, and a
 * beam from its center along +Z, which `lookAt` turns toward the lit scene.
 */
function createSunGizmoGeometry(): BufferGeometry {
  const segments = 24;
  const rays = 8;
  const positions: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    positions.push(
      Math.cos(a) * SUN_GIZMO_RADIUS,
      Math.sin(a) * SUN_GIZMO_RADIUS,
      0,
      Math.cos(b) * SUN_GIZMO_RADIUS,
      Math.sin(b) * SUN_GIZMO_RADIUS,
      0,
    );
  }
  const inner = SUN_GIZMO_RADIUS * 1.35;
  const outer = inner + SUN_GIZMO_RAY;
  for (let i = 0; i < rays; i += 1) {
    const a = (i / rays) * Math.PI * 2;
    positions.push(Math.cos(a) * inner, Math.sin(a) * inner, 0);
    positions.push(Math.cos(a) * outer, Math.sin(a) * outer, 0);
  }
  positions.push(0, 0, 0, 0, 0, SUN_GIZMO_BEAM);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return geometry;
}

/** Writes a linear RGBA (the editor's color model) onto a Three color, ignoring alpha. */
function setLinear(color: Color, rgba: Rgba): void {
  // Three's working color space is linear-sRGB, so `setRGB` takes our linear channels as-is.
  color.setRGB(rgba[0], rgba[1], rgba[2]);
}
