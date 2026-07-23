/**
 * The Blender-style modal transform tool for the preview. While the Viewport panel is active, `G` /
 * `R` / `S` begin a grab / rotate / scale of the selected entity; moving the mouse then drives it
 * live, `X` / `Y` / `Z` constrain to that axis (local or global, per the Local/Global space toggle),
 * `Shift`+axis constrains to the plane of the other two, left-click / `Enter` confirm, and
 * right-click / `Esc` cancel back to the start pose. On confirm it commits the base transform
 * through {@link setEntityBaseChannel} - base only, never keyframes (keys come from `I` / the menu).
 * While a modal op runs, orbit controls are disabled and the timeline's transform drive is locked.
 */

import type { Object3D } from "three";
import { Quaternion, Raycaster, Vector2, Vector3, type PerspectiveCamera } from "three";
import { setEntityBaseChannel } from "../../model/commands";
import type { SceneEntity } from "../../model/entity";
import type { SelectionStore } from "../../model/selectionStore";
import type { Store } from "../../model/store";
import type { GizmoSettingsStore } from "../../settings/gizmoSettings";
import type { SceneEmitters } from "../../render/sceneEmitters";
import type { TransformGuides } from "../../render/transformGuides";
import type { EditorContext } from "../editorContext";

const DEGREES_TO_RADIANS = Math.PI / 180;
/** Grab is plane-cast from the cursor, so a fast mouse move can imply a huge jump; cap it per drag. */
const MAX_GRAB_DELTA = 50;

type Mode = "grab" | "rotate" | "scale";

/** The active axis/plane restriction. `axis` indexes X/Y/Z; for a plane it is the *excluded* axis. */
type Constraint =
  | { readonly kind: "free" }
  | { readonly kind: "axis"; readonly axis: 0 | 1 | 2 }
  | { readonly kind: "plane"; readonly axis: 0 | 1 | 2 };

const FREE: Constraint = { kind: "free" };

/** State captured when a modal op begins - everything `update()` needs to recompute from scratch. */
interface DragStart {
  readonly mode: Mode;
  /** The entity captured at grab time - committed to on confirm, regardless of later selection. */
  readonly entity: SceneEntity;
  readonly object: Object3D;
  readonly entityChannel: "position" | "rotation" | "scale";
  readonly startLocalPosition: Vector3;
  readonly startLocalQuaternion: Quaternion;
  readonly startScale: Vector3;
  readonly startWorldPosition: Vector3;
  readonly startWorldQuaternion: Quaternion;
  readonly parentInverseQuaternion: Quaternion;
  /** World-space directions of the entity's local X/Y/Z axes at grab time. */
  readonly axisDirections: readonly [Vector3, Vector3, Vector3];
  /** Free grab/rotate: the view-facing plane normal (camera forward at grab time). */
  readonly planeNormal: Vector3;
  /** Rotate/scale: the entity origin projected to screen pixels, and the start angle/distance. */
  readonly centerPixel: Vector2;
  readonly startAngle: number;
  readonly startDistance: number;
}

export class TransformTool {
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private start: DragStart | undefined = undefined;
  private constraint: Constraint = FREE;
  // Grab only: the drag-plane point that reads as zero delta, recaptured whenever the constraint
  // (and therefore the drag plane) changes, so switching axis/plane mid-drag never jumps the object.
  private dragReference = new Vector3();
  // Whether Ctrl is currently held - temporarily inverts each mode's snap (Blender-style).
  private ctrlHeld = false;
  private readonly store: Store;
  private readonly selection: SelectionStore;
  private readonly gizmoSettings: GizmoSettingsStore;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly domElement: HTMLElement,
    private readonly guides: TransformGuides,
    private readonly setControlsEnabled: (enabled: boolean) => void,
    private readonly emitters: SceneEmitters,
    context: EditorContext,
  ) {
    this.store = context.store;
    this.selection = context.selection;
    this.gizmoSettings = context.gizmoSettings;
    // Track the pointer continuously (so a keypress-initiated op knows where the mouse is) and
    // drive the live transform on the same move - `update()` no-ops while no op is active.
    window.addEventListener("pointermove", (event) => {
      this.pointer.set(event.clientX, event.clientY);
      this.ctrlHeld = event.ctrlKey;
      this.update();
    });
    window.addEventListener("keydown", (event) => this.onKeyDown(event), true);
    window.addEventListener("keyup", (event) => this.onKeyUp(event), true);
    window.addEventListener("pointerdown", (event) => this.onPointerDown(event), true);
  }

  public isActive(): boolean {
    return this.start !== undefined;
  }

  /** Begins a modal `mode` on the selected entity. No-op if already active or the object is absent. */
  public begin(mode: Mode): void {
    if (this.start !== undefined) {
      return;
    }
    const entity = this.selection.get();
    const object = this.emitters.entityObject(entity);
    if (object === undefined) {
      return;
    }
    object.updateWorldMatrix(true, false);

    const startWorldQuaternion = object.getWorldQuaternion(new Quaternion());
    const parentWorldQuaternion = object.parent
      ? object.parent.getWorldQuaternion(new Quaternion())
      : new Quaternion();
    // Constraint axes are the object's own frame in "local" space, or the world axes in "global"
    // space (the preview's Local/Global toggle).
    const local = this.gizmoSettings.get().space === "local";
    const basis = local ? startWorldQuaternion : new Quaternion();
    const axisDirections: [Vector3, Vector3, Vector3] = [
      new Vector3(1, 0, 0).applyQuaternion(basis).normalize(),
      new Vector3(0, 1, 0).applyQuaternion(basis).normalize(),
      new Vector3(0, 0, 1).applyQuaternion(basis).normalize(),
    ];
    const startWorldPosition = object.getWorldPosition(new Vector3());
    const planeNormal = this.camera.getWorldDirection(new Vector3()).normalize();
    const centerPixel = this.projectToScreen(startWorldPosition);

    this.start = {
      mode,
      entity,
      object,
      entityChannel: mode === "grab" ? "position" : mode === "rotate" ? "rotation" : "scale",
      startLocalPosition: object.position.clone(),
      startLocalQuaternion: object.quaternion.clone(),
      startScale: object.scale.clone(),
      startWorldPosition,
      startWorldQuaternion,
      parentInverseQuaternion: parentWorldQuaternion.invert(),
      axisDirections,
      planeNormal,
      centerPixel,
      startAngle: Math.atan2(this.pointer.y - centerPixel.y, this.pointer.x - centerPixel.x),
      startDistance: Math.max(1e-3, this.pointer.distanceTo(centerPixel)),
    };
    this.constraint = FREE;
    this.captureDragReference(this.start);
    this.setControlsEnabled(false);
    this.emitters.setTransformLock(true);
    this.rebuildGuide();
    this.update();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.start === undefined) {
      return;
    }
    if (event.code === "ControlLeft" || event.code === "ControlRight") {
      // Ctrl toggles snap for the live drag - re-evaluate without swallowing the key.
      this.ctrlHeld = true;
      this.update();
      return;
    }
    const axis = AXIS_FOR_CODE[event.code];
    if (event.code === "Escape") {
      this.finish(true);
    } else if (event.code === "Enter" || event.code === "NumpadEnter") {
      this.finish(false);
    } else if (axis !== undefined) {
      this.setConstraint(event.shiftKey ? { kind: "plane", axis } : { kind: "axis", axis });
    } else if (event.code === "KeyG" || event.code === "KeyR" || event.code === "KeyS") {
      // Swallow another mode key so it can't re-enter the router mid-op; the current op continues.
    } else {
      return; // let other keys through
    }
    // Handled keys never reach the hotkey router (which also listens on window).
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (
      this.start !== undefined &&
      (event.code === "ControlLeft" || event.code === "ControlRight")
    ) {
      this.ctrlHeld = false;
      this.update();
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.start === undefined) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.pointer.set(event.clientX, event.clientY);
    this.finish(event.button === 2); // right-click cancels, anything else confirms
  }

  private setConstraint(next: Constraint): void {
    // Pressing the same axis/plane again clears it (back to free), mirroring Blender's toggle.
    this.constraint = sameConstraint(this.constraint, next) ? FREE : next;
    // The drag plane depends on the constraint; recapture so switching mid-drag doesn't jump.
    if (this.start?.mode === "grab") {
      this.captureDragReference(this.start);
    }
    this.rebuildGuide();
    this.update();
  }

  private update(): void {
    const start = this.start;
    if (start === undefined) {
      return;
    }
    switch (start.mode) {
      case "grab":
        this.updateGrab(start);
        break;
      case "rotate":
        this.updateRotate(start);
        break;
      case "scale":
        this.updateScale(start);
        break;
    }
    this.guides.reposition(start.object.getWorldPosition(new Vector3()));
  }

  private updateGrab(start: DragStart): void {
    const current = this.computeDragPoint(this.pointer, start);
    if (current === undefined) {
      return;
    }
    const delta = current.sub(this.dragReference);
    if (delta.length() > MAX_GRAB_DELTA) {
      delta.setLength(MAX_GRAB_DELTA);
    }
    const world = start.startWorldPosition.clone().add(delta);
    const local = start.object.parent ? start.object.parent.worldToLocal(world) : world;
    // Snap the local offset from the start pose to the move increment (per axis).
    const snap = this.snapFor("move");
    if (snap.on) {
      local.x =
        start.startLocalPosition.x + snapRound(local.x - start.startLocalPosition.x, snap.step);
      local.y =
        start.startLocalPosition.y + snapRound(local.y - start.startLocalPosition.y, snap.step);
      local.z =
        start.startLocalPosition.z + snapRound(local.z - start.startLocalPosition.z, snap.step);
    }
    this.emitters.applyEntityLocalTransform(start.entity, { position: local });
  }

  private updateRotate(start: DragStart): void {
    const angle = Math.atan2(
      this.pointer.y - start.centerPixel.y,
      this.pointer.x - start.centerPixel.x,
    );
    let delta = angle - start.startAngle;
    // Free rotation spins about the view axis; a constraint spins about that axis.
    const axisIndex = this.constraint.kind === "free" ? undefined : this.constraint.axis;
    const axis =
      axisIndex === undefined ? start.planeNormal.clone() : start.axisDirections[axisIndex].clone();
    // Screen y points down, so a clockwise mouse drag increases `angle`. Flip by the axis's facing
    // so a clockwise drag always reads as a clockwise on-screen rotation, whichever way the axis points.
    const sign = axis.dot(start.planeNormal) >= 0 ? 1 : -1;
    delta *= sign;
    const snap = this.snapFor("rotate");
    if (snap.on) {
      delta = snapRound(delta, snap.step * DEGREES_TO_RADIANS); // snap the angle to whole step-degree increments
    }
    const deltaQuaternion = new Quaternion().setFromAxisAngle(axis, delta);
    const world = deltaQuaternion.multiply(start.startWorldQuaternion);
    const localQuaternion = start.parentInverseQuaternion.clone().multiply(world);
    this.emitters.applyEntityLocalTransform(start.entity, { quaternion: localQuaternion });
  }

  private updateScale(start: DragStart): void {
    const ratio = Math.max(1e-3, this.pointer.distanceTo(start.centerPixel)) / start.startDistance;
    const scale = start.startScale.clone();
    const factors = this.scaleFactors(ratio);
    scale.set(scale.x * factors[0], scale.y * factors[1], scale.z * factors[2]);
    const snap = this.snapFor("scale");
    if (snap.on) {
      scale.set(
        snapScale(scale.x, snap.step),
        snapScale(scale.y, snap.step),
        snapScale(scale.z, snap.step),
      );
    }
    this.emitters.applyEntityLocalTransform(start.entity, { scale });
  }

  /** Effective snap for a mode: the setting, inverted while Ctrl is held (Blender-style toggle). */
  private snapFor(kind: "move" | "rotate" | "scale"): { on: boolean; step: number } {
    const setting = this.gizmoSettings.get()[kind];
    return { on: this.ctrlHeld ? !setting.enabled : setting.enabled, step: setting.step };
  }

  /** Captures the current pointer's drag point as the reference that reads as zero delta. */
  private captureDragReference(start: DragStart): void {
    this.dragReference =
      this.computeDragPoint(this.pointer, start) ?? start.startWorldPosition.clone();
  }

  /**
   * The world point `clientPixel` maps to under the active constraint: cast onto the true
   * constraint plane/axis (not a fixed view-facing plane), so the projection's perspective
   * behavior - e.g. a translate speed that blows up when the axis is viewed edge-on, exactly as
   * in Blender - falls out of the geometry instead of being approximated by a post-hoc projection.
   */
  private computeDragPoint(clientPixel: Vector2, start: DragStart): Vector3 | undefined {
    const plane = this.dragPlaneFor(start);
    const hit = this.rayToPlane(clientPixel, plane.normal, plane.point);
    if (hit === undefined) {
      return undefined;
    }
    if (this.constraint.kind !== "axis") {
      return hit;
    }
    const axis = start.axisDirections[this.constraint.axis];
    const distance = hit.sub(start.startWorldPosition).dot(axis);
    return start.startWorldPosition.clone().addScaledVector(axis, distance);
  }

  /** The plane the drag ray is cast onto, chosen so it matches the active constraint's geometry. */
  private dragPlaneFor(start: DragStart): { normal: Vector3; point: Vector3 } {
    if (this.constraint.kind === "plane") {
      // The real world plane (Shift+axis excludes that axis), not a view-facing stand-in.
      return {
        normal: start.axisDirections[this.constraint.axis],
        point: start.startWorldPosition,
      };
    }
    if (this.constraint.kind === "axis") {
      // The plane containing the axis line, tilted to face the camera as much as possible: normal =
      // axis x (axis x eye). Degenerates to zero when looking straight down the axis (eye || axis) -
      // fall back to the view-facing plane rather than cast against a near-zero normal.
      const axis = start.axisDirections[this.constraint.axis];
      const eye = this.camera.position.clone().sub(start.startWorldPosition);
      const normal = axis.clone().cross(axis.clone().cross(eye));
      if (normal.lengthSq() < 1e-8) {
        return { normal: start.planeNormal, point: start.startWorldPosition };
      }
      return { normal: normal.normalize(), point: start.startWorldPosition };
    }
    return { normal: start.planeNormal, point: start.startWorldPosition };
  }

  /** Per-component scale multipliers for `ratio` under the active constraint. */
  private scaleFactors(ratio: number): [number, number, number] {
    const factors: [number, number, number] = [1, 1, 1];
    if (this.constraint.kind === "axis") {
      factors[this.constraint.axis] = ratio;
    } else if (this.constraint.kind === "plane") {
      for (let i = 0; i < 3; i += 1) {
        if (i !== this.constraint.axis) {
          factors[i] = ratio;
        }
      }
    } else {
      factors[0] = factors[1] = factors[2] = ratio;
    }
    return factors;
  }

  private finish(cancel: boolean): void {
    const start = this.start;
    if (start === undefined) {
      return;
    }
    this.start = undefined;
    this.guides.clear();
    this.emitters.setTransformLock(false);
    this.setControlsEnabled(true);

    if (cancel) {
      this.emitters.applyEntityLocalTransform(start.entity, {
        position: start.startLocalPosition,
        quaternion: start.startLocalQuaternion,
        scale: start.startScale,
      });
      return;
    }
    this.commit(start);
  }

  private commit(start: DragStart): void {
    const entity = start.entity;
    const object = start.object;
    // Parked (not a frame entry), so the manual pose must hold: mark it before committing the base
    // so the view re-pose that the commit triggers leaves the dragged object put (see markManualPose).
    this.emitters.markManualPose(entity);
    if (start.entityChannel === "position") {
      setEntityBaseChannel(this.store, entity, "position", [
        object.position.x,
        object.position.y,
        object.position.z,
      ]);
    } else if (start.entityChannel === "rotation") {
      const quaternion = object.quaternion;
      setEntityBaseChannel(this.store, entity, "rotation", [
        quaternion.x,
        quaternion.y,
        quaternion.z,
        quaternion.w,
      ]);
    } else {
      setEntityBaseChannel(this.store, entity, "scale", [
        object.scale.x,
        object.scale.y,
        object.scale.z,
      ]);
    }
  }

  /** Intersects the camera ray through `clientPixel` with the plane `normal` dot `(p - point)` = 0. */
  private rayToPlane(clientPixel: Vector2, normal: Vector3, point: Vector3): Vector3 | undefined {
    this.raycaster.setFromCamera(this.toNdc(clientPixel), this.camera);
    const ray = this.raycaster.ray;
    const denominator = normal.dot(ray.direction);
    if (Math.abs(denominator) < 1e-6) {
      return undefined;
    }
    const distance = normal.dot(point.clone().sub(ray.origin)) / denominator;
    if (distance < 0) {
      return undefined;
    }
    return ray.at(distance, new Vector3());
  }

  /** Client pixel coordinates -> normalized device coordinates for the preview canvas. */
  private toNdc(clientPixel: Vector2): Vector2 {
    const rectangle = this.domElement.getBoundingClientRect();
    return new Vector2(
      ((clientPixel.x - rectangle.left) / rectangle.width) * 2 - 1,
      -((clientPixel.y - rectangle.top) / rectangle.height) * 2 + 1,
    );
  }

  /** A world point -> client pixel coordinates (the inverse of {@link toNdc}). */
  private projectToScreen(world: Vector3): Vector2 {
    const rectangle = this.domElement.getBoundingClientRect();
    const ndc = world.clone().project(this.camera);
    return new Vector2(
      rectangle.left + ((ndc.x + 1) / 2) * rectangle.width,
      rectangle.top + ((1 - ndc.y) / 2) * rectangle.height,
    );
  }

  private rebuildGuide(): void {
    const start = this.start;
    const constraint = this.constraint;
    if (start === undefined || constraint.kind === "free") {
      this.guides.clear();
      return;
    }
    const axes =
      constraint.kind === "axis"
        ? [constraint.axis]
        : ([0, 1, 2] as const).filter((i) => i !== constraint.axis);
    this.guides.show(axes, start.axisDirections, start.object.getWorldPosition(new Vector3()));
  }
}

/** The axis index a physical key selects (X = 0, Y = 1, Z = 2). */
const AXIS_FOR_CODE: Record<string, 0 | 1 | 2 | undefined> = {
  KeyX: 0,
  KeyY: 1,
  KeyZ: 2,
};

/** Rounds `value` to the nearest multiple of `step` (a `step` of 0 is a no-op). */
function snapRound(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

/** Snaps a scale factor to the increment, never letting it collapse to a degenerate 0. */
function snapScale(value: number, step: number): number {
  const snapped = snapRound(value, step);
  return Math.abs(snapped) < step ? step * Math.sign(snapped || 1) : snapped;
}

function sameConstraint(first: Constraint, second: Constraint): boolean {
  if (first.kind !== second.kind) {
    return false;
  }
  const axisOf = (constraint: Constraint): number =>
    constraint.kind === "free" ? -1 : constraint.axis;
  return axisOf(first) === axisOf(second);
}
