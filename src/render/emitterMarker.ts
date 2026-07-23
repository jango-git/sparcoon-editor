/**
 * Persistent preview gizmo: a wireframe outline parented under each object, shaped by kind and
 * tinted (matching the timeline row accents) when selected. Carries an invisible pick-target box
 * since the outline's line geometry is too thin to raycast reliably.
 */

import {
  BoxGeometry,
  Color,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OctahedronGeometry,
  SRGBColorSpace,
  TetrahedronGeometry,
  type BufferGeometry,
  type Object3D,
} from "three";
import {
  ENTITY_ACCENT_HUE,
  ENTITY_ACCENT_LIGHTNESS,
  ENTITY_ACCENT_SATURATION,
} from "../theme/entityAccent";

/** The kind of object a marker stands for - picks its outline shape. */
export type MarkerKind = "vfx" | "emitter" | "vfxMesh";

/** Empty cube for the VFX group (0.25 units); a gem (octahedron) for an emitter; a tetra for a mesh. */
const VFX_CUBE = 0.25;
const EMITTER_GEM_RADIUS = 0.12;
const MESH_GEM_RADIUS = 0.15;

const COLOR_IDLE = new Color(0x8894a6);

/** The selected-outline tint for `kind` - its shared accent hue, as an sRGB color. */
function selectedColor(kind: MarkerKind): Color {
  return new Color().setHSL(
    ENTITY_ACCENT_HUE[kind] / 360,
    ENTITY_ACCENT_SATURATION,
    ENTITY_ACCENT_LIGHTNESS,
    SRGBColorSpace,
  );
}

export interface GizmoMarker {
  /** The Object3D to add under the tracked object - moves/rotates/scales with it. */
  readonly object: Object3D;
  /** Invisible mesh sized to the gizmo, raycast to pick this object in the viewport. */
  readonly pickTarget: Object3D;
  /** Tints the outline to show whether this object is the selected one. */
  setSelected(selected: boolean): void;
  /** Frees the marker's geometry/material (called when the owner is destroyed). */
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
