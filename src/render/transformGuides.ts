/**
 * The axis/plane guide lines the modal transform tool shows while a drag is constrained. Owns the
 * Line objects so the UI tool never touches the scene graph directly - only `show`/`reposition`/`clear`.
 * Axis directions are fixed at grab; only the center moves, so `reposition` just re-lays endpoints.
 */

import type { Vector3 } from "three";
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  type Scene,
} from "three";

/** Axis guide colors (X red, Y green, Z blue) - the usual gizmo convention. */
const AXIS_COLORS = [0xff5566, 0x55dd66, 0x5599ff] as const;
/** Half-length of a guide line (long enough to read as "infinite" across the viewport). */
const GUIDE_HALF = 1000;

export class TransformGuides {
  private lines: { readonly line: Line; readonly axis: 0 | 1 | 2 }[] = [];
  private axisDirections: readonly [Vector3, Vector3, Vector3] | undefined;

  constructor(private readonly scene: Scene) {}

  /** Draws a guide per `axis` along `axisDirections`, centred at `center`; replaces any current guides. */
  public show(
    axes: readonly (0 | 1 | 2)[],
    axisDirections: readonly [Vector3, Vector3, Vector3],
    center: Vector3,
  ): void {
    this.clear();
    this.axisDirections = axisDirections;
    for (const axis of axes) {
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(new Array(6).fill(0), 3));
      const line = new Line(
        geometry,
        new LineBasicMaterial({ color: new Color(AXIS_COLORS[axis]) }),
      );
      this.scene.add(line);
      this.lines.push({ line, axis });
    }
    this.reposition(center);
  }

  /** Re-lays the active guides' endpoints around `center` (called as the entity moves). */
  public reposition(center: Vector3): void {
    const axisDirections = this.axisDirections;
    if (axisDirections === undefined) {
      return;
    }
    for (const { line, axis } of this.lines) {
      const direction = axisDirections[axis];
      const startPoint = center.clone().addScaledVector(direction, -GUIDE_HALF);
      const endPoint = center.clone().addScaledVector(direction, GUIDE_HALF);
      const position = line.geometry.getAttribute("position") as Float32BufferAttribute;
      position.setXYZ(0, startPoint.x, startPoint.y, startPoint.z);
      position.setXYZ(1, endPoint.x, endPoint.y, endPoint.z);
      position.needsUpdate = true;
    }
  }

  public clear(): void {
    for (const { line } of this.lines) {
      line.removeFromParent();
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    }
    this.lines = [];
    this.axisDirections = undefined;
  }
}
