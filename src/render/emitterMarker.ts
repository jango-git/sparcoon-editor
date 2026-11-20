/**
 * Wireframe gizmo under each object, with an invisible box for picking because the thin outline
 * lines are hard to raycast.
 */

import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  OctahedronGeometry,
  SRGBColorSpace,
  TetrahedronGeometry,
} from "three";

import {
  ENTITY_ACCENT_HUE,
  ENTITY_ACCENT_LIGHTNESS,
  ENTITY_ACCENT_SATURATION,
} from "../theme/entityAccent";
import { markEditorGizmo } from "./editorOverlay";

export type MarkerKind = "vfx" | "emitter" | "vfxMesh";

/**
 * Marker sizes in world units: a cube for the VFX group, an octahedron for an emitter, a
 * tetrahedron for a mesh.
 */
const VFX_CUBE = 0.25;
const EMITTER_GEM_RADIUS = 0.12;
const MESH_GEM_RADIUS = 0.15;

const COLOR_IDLE = new Color(0x8894a6);

function selectedColor(kind: MarkerKind): Color {
  return new Color().setHSL(
    ENTITY_ACCENT_HUE[kind] / 360,
    ENTITY_ACCENT_SATURATION,
    ENTITY_ACCENT_LIGHTNESS,
    SRGBColorSpace,
  );
}

export interface GizmoMarker {
  /** Added under the tracked object. */
  readonly object: Object3D;
  readonly pickTarget: Object3D;
  setSelected(selected: boolean): void;
  dispose(): void;
}

function markerSource(kind: MarkerKind): BufferGeometry {
  switch (kind) {
    case "vfx":
      return new BoxGeometry(VFX_CUBE, VFX_CUBE, VFX_CUBE);
    case "emitter":
      return new OctahedronGeometry(EMITTER_GEM_RADIUS);
    case "vfxMesh":
      return new TetrahedronGeometry(MESH_GEM_RADIUS);
  }
}

function gizmoName(kind: MarkerKind): string {
  switch (kind) {
    case "vfx":
      return "VfxGizmo";
    case "emitter":
      return "EmitterGizmo";
    case "vfxMesh":
      return "MeshGizmo";
  }
}

function pickSizeFor(kind: MarkerKind): number {
  switch (kind) {
    case "vfx":
      return VFX_CUBE * 1.15;
    case "emitter":
      return EMITTER_GEM_RADIUS * 2.4;
    case "vfxMesh":
      return MESH_GEM_RADIUS * 2.4;
  }
}

export function createGizmoMarker(kind: MarkerKind): GizmoMarker {
  const source = markerSource(kind);
  const geometry = new EdgesGeometry(source);
  source.dispose();
  // Unlit line material - `toneMapped: false` keeps its color exactly as set, like the player figure.
  const material = new LineBasicMaterial({ color: COLOR_IDLE.clone(), toneMapped: false });
  const lines = new LineSegments(geometry, material);
  lines.name = gizmoName(kind);

  // Pick proxy: fully transparent, no depth write, but still raycastable - slightly larger than
  // the outline so it's an easy click target.
  const pickSize = pickSizeFor(kind);
  const pickGeometry = new BoxGeometry(pickSize, pickSize, pickSize);
  const pickMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const pickMesh = new Mesh(pickGeometry, pickMaterial);
  pickMesh.name = "GizmoPick";
  lines.add(pickMesh);
  markEditorGizmo(lines);

  const colorSelected = selectedColor(kind);
  return {
    object: lines,
    pickTarget: pickMesh,
    setSelected(selected: boolean): void {
      material.color.copy(selected ? colorSelected : COLOR_IDLE);
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
      pickGeometry.dispose();
      pickMaterial.dispose();
    },
  };
}
