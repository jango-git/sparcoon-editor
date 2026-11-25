/**
 * Studio around the emitters: sun, ambient fill, background, grid, player figure, gizmos. The
 * ground belongs to the studio scene (`PreviewScene`). Ambient fill is either
 * a live `HemisphereLight` or an SH probe baked from the active HDRI, never both. The sun stays
 * live in both cases.
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
import { markEditorGizmo, markEditorOverlay } from "./editorOverlay";
import type { DecodedEnvironment } from "./environmentTexture";
import { GROUND_SIZE, GROUND_Y } from "./previewScene";

/** Distance the sun sits from the origin; its azimuth/elevation place it on this sphere. */
const SUN_DISTANCE = 14;

/**
 * Sun gizmo distance from the origin, along the sun direction. Closer than the light so it stays in
 * view.
 */
const SUN_GIZMO_DISTANCE = 3;

/** Sun gizmo: disc radius, ray length beyond the disc, and the line toward the lit scene. */
const SUN_GIZMO_RADIUS = 0.12;
const SUN_GIZMO_RAY = 0.08;
const SUN_GIZMO_BEAM = 0.9;

const SUN_GIZMO_COLOR = 0xffd24a;

/** Half-extent of the sun's orthographic shadow frustum (the shadow box). */
const SHADOW_BOX_HALF = 30;

/** Player-figure box dimensions (width x height x depth) - a standing scale reference. */
const PLAYER_SIZE: readonly [number, number, number] = [0.5, 2, 0.75];

/** Cube face size for the SH bake. Band-2 SH needs only low frequencies. */
const BAKE_FACE_SIZE = 16;

/** Grid color for every line that is not an axis - lighter than the ground, so the cells read. */
const GRID_MINOR_COLOR = 0x565b66;

export class SceneEnvironment {
  private readonly background = new Color();
  private readonly sun: DirectionalLight;
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

    // Bake rig. The dome, textured with the active HDRI, renders into a cube target that is
    // projected to SH. Linear, so probe irradiance stays linear.
    this.bakeTarget.texture.colorSpace = LinearSRGBColorSpace;
    this.bakeScene.add(new Mesh(this.domeGeometry, this.domeMaterial));
    scene.add(this.probe);

    // Position comes from azimuth and elevation in `apply`.
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

    // Raised slightly to avoid z-fighting. Tone mapping off keeps axis colors exact at any
    // exposure.
    this.gridGeometry = createGridGeometry(GROUND_SIZE, GROUND_SIZE);
    this.gridMaterial = new LineBasicMaterial({ vertexColors: true, toneMapped: false });
    this.grid = new LineSegments(this.gridGeometry, this.gridMaterial);
    this.grid.position.y = GROUND_Y + 0.01;
    markEditorOverlay(this.grid);
    scene.add(this.grid);

    this.playerGeometry = new EdgesGeometry(new BoxGeometry(...PLAYER_SIZE));
    this.playerMaterial = new LineBasicMaterial({ color: 0x00e0a0 });
    this.player = new LineSegments(this.playerGeometry, this.playerMaterial);
    // Offset 1 unit on x, clear of the emitter origin.
    this.player.position.set(1, GROUND_Y + PLAYER_SIZE[1] / 2, 0);
    markEditorOverlay(this.player);
    scene.add(this.player);

    // Hidden together with the object outlines by the gizmo layer.
    this.sunGizmoGeometry = createSunGizmoGeometry();
    this.sunGizmoMaterial = new LineBasicMaterial({ color: SUN_GIZMO_COLOR, toneMapped: false });
    this.sunGizmo = new LineSegments(this.sunGizmoGeometry, this.sunGizmoMaterial);
    this.sunGizmo.name = "SunGizmo";
    markEditorGizmo(this.sunGizmo);
    scene.add(this.sunGizmo);

    this.apply(settings, activeEnvironment);
  }

  /**
   * Applies settings to lights, gizmos and background. An active environment replaces the
   * Hemisphere fill.
   */
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
      // Forces a rebake on the next environment activation, even for a known texture.
      this.bakedTexture = undefined;
    }
    this.grid.visible = settings.grid;
    this.player.visible = settings.playerFigure;
  }

  public destroy(): void {
    this.scene.remove(
      this.sun,
      this.sun.target,
      this.hemisphereLight,
      this.probe,
      this.grid,
      this.player,
      this.sunGizmo,
    );
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

  /**
   * Rebakes the SH probe only when `texture` changed, since the bake renders a cube and reads
   * pixels back.
   */
  private bakeFromTexture(texture: DataTexture): void {
    if (this.bakedTexture === texture) {
      return;
    }
    this.domeMaterial.map = texture;
    this.domeMaterial.needsUpdate = true;
    // Render or readback can throw on a lost GL context. Keep the last probe and commit only on
    // success, so the next apply retries.
    try {
      this.bakeCamera.update(this.renderer, this.bakeScene);
      this.probe.sh.copy(
        LightProbeGenerator.fromCubeRenderTarget(this.renderer, this.bakeTarget).sh,
      );
      this.bakedTexture = texture;
    } catch {
      // Keep the previous probe.
    }
  }

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
 * Ground grid as one line-segment geometry. Per-vertex colors let the two axis lines differ without
 * a second draw call.
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

function setLinear(color: Color, rgba: Rgba): void {
  // Three's working color space is linear-sRGB, so `setRGB` takes our linear channels as-is.
  color.setRGB(rgba[0], rgba[1], rgba[2]);
}
