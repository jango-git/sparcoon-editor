/**
 * The 3D view of an SDF bake: the mesh being baked, the box the volume fills and the surface the
 * last bake holds at the session's level, all in the mesh's own space. It has a renderer of its own
 * while a session runs, draws when something changes (an orbit, an edit, a resize), and frames the
 * box when a session starts.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { volumeSurface } from "../domain/volumeSurface";
import type { VolumeBakeSession, VolumeBakeState } from "../model/volumeBakeSession";
import { DEFAULT_PREVIEW_SETTINGS } from "../settings/previewSettings";
import { buildGeometryFromArrays } from "./meshGeometryBaking";

const MESH_COLOR = 0x9aa4b2;
const BOX_COLOR = 0xf08c2e;
const SURFACE_COLOR = 0x4fd1c5;
const FIELD_OF_VIEW = 35;

interface View {
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
}

export class VolumeBakePreview {
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FIELD_OF_VIEW, 1, 0.01, 1000);
  private readonly meshMaterial = new MeshStandardMaterial({
    color: MESH_COLOR,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  private readonly surfaceMaterial = new MeshStandardMaterial({
    color: SURFACE_COLOR,
    roughness: 0.6,
    side: DoubleSide,
  });
  /** Placed at the box's centre and scaled to its extent - a unit cube's edges under it. */
  private readonly box = new Group();
  private view: View | undefined;
  private mesh: Mesh | undefined;
  private surface: Mesh | undefined;
  // What the drawn pieces were made from, to remake only what changed.
  private shownMesh: VolumeBakeState["mesh"] | undefined;
  private shownSurface: { baked: VolumeBakeState["baked"]; level: number } | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly session: VolumeBakeSession,
  ) {
    this.box.add(
      new LineSegments(
        new EdgesGeometry(new BoxGeometry(1, 1, 1)),
        new LineBasicMaterial({ color: BOX_COLOR }),
      ),
    );
    const sun = new DirectionalLight(0xffffff, 2);
    sun.position.set(3, 5, 4);
    this.scene.add(new HemisphereLight(0xffffff, 0x404040, 1.5), sun, this.box);
    // The main preview's default background; linear like the setting, as Three's working space is.
    const [red, green, blue] = DEFAULT_PREVIEW_SETTINGS.background;
    this.scene.background = new Color().setRGB(red, green, blue);
    session.subscribe(() => this.sync());
    new ResizeObserver(() => this.draw()).observe(host);
  }

  private sync(): void {
    const state = this.session.get();
    if (state === undefined) {
      this.replaceMesh(undefined);
      this.replaceSurface(undefined);
      this.release();
      return;
    }
    const { boxMin, boxMax } = state.settings;
    const min = new Vector3(...boxMin);
    const max = new Vector3(...boxMax);
    this.box.position.copy(min).add(max).multiplyScalar(0.5);
    this.box.scale.copy(max).sub(min);
    if (state.mesh !== this.shownMesh) {
      this.replaceMesh(state.mesh);
      this.frame();
    }
    const shown = this.shownSurface;
    if (shown === undefined || state.baked !== shown.baked || state.level !== shown.level) {
      this.replaceSurface(state);
    }
    this.draw();
  }

  private frame(): void {
    const radius = Math.max(this.box.scale.length() / 2, 0.01);
    const distance = radius / Math.sin(((FIELD_OF_VIEW / 2) * Math.PI) / 180);
    const direction = new Vector3(0.6, 0.45, 1).normalize();
    this.camera.position.copy(this.box.position).addScaledVector(direction, distance * 1.1);
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    const { controls } = this.acquire();
    controls.target.copy(this.box.position);
    controls.update();
  }

  private draw(): void {
    if (this.session.get() === undefined) {
      return;
    }
    const { renderer } = this.acquire();
    const { width, height } = this.host.getBoundingClientRect();
    if (width === 0 || height === 0) {
      return;
    }
    renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    renderer.render(this.scene, this.camera);
  }

  private acquire(): View {
    if (this.view === undefined) {
      const renderer = new WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.domElement.className = "volume-baker__canvas";
      this.host.append(renderer.domElement);
      const controls = new OrbitControls(this.camera, renderer.domElement);
      controls.addEventListener("change", () => this.draw());
      this.view = { renderer, controls };
    }
    return this.view;
  }

  /** Releases the WebGL context. A page can hold only a few. */
  private release(): void {
    if (this.view !== undefined) {
      this.view.controls.dispose();
      this.view.renderer.dispose();
      this.view.renderer.domElement.remove();
      this.view = undefined;
    }
  }

  private replaceMesh(mesh: VolumeBakeState["mesh"] | undefined): void {
    if (this.mesh !== undefined) {
      this.mesh.geometry.dispose();
      this.mesh.removeFromParent();
      this.mesh = undefined;
    }
    this.shownMesh = mesh;
    if (mesh !== undefined) {
      this.mesh = new Mesh(buildGeometryFromArrays(mesh.geometry), this.meshMaterial);
      this.scene.add(this.mesh);
    }
  }

  private replaceSurface(state: VolumeBakeState | undefined): void {
    if (this.surface !== undefined) {
      this.surface.geometry.dispose();
      this.surface.removeFromParent();
      this.surface = undefined;
    }
    this.shownSurface =
      state === undefined ? undefined : { baked: state.baked, level: state.level };
    if (state?.baked === undefined) {
      return;
    }
    const { positions, normals, indices } = volumeSurface(state.baked, state.level);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new BufferAttribute(normals, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    this.surface = new Mesh(geometry, this.surfaceMaterial);
    this.scene.add(this.surface);
  }
}
