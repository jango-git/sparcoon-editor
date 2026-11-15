/**
 * The transform selection: which scene entity (VFX group or one emitter/mesh) the preview gizmo
 * and hotkeys target. Transient like the transport - editor focus, never in the model/history/saved doc.
 */

import { Ferrsign0 } from "ferrsign";

import { emitterEntity, sameEntity, type SceneEntity, VFX_ENTITY, vfxMeshEntity } from "./entity";

export type SelectionListener = () => void;

export class SelectionStore {
  private current: SceneEntity = VFX_ENTITY;
  private readonly changed = new Ferrsign0();

  /** The entity the gizmo/hotkeys act on. */
  public get(): SceneEntity {
    return this.current;
  }

  /** Targets the VFX group. */
  public selectVfx(): void {
    this.set(VFX_ENTITY);
  }

  /** Targets emitter `id`. */
  public selectEmitter(id: string): void {
    this.set(emitterEntity(id));
  }

  /** Targets VFX mesh `id`. */
  public selectVfxMesh(id: string): void {
    this.set(vfxMeshEntity(id));
  }

  public set(entity: SceneEntity): void {
    if (sameEntity(entity, this.current)) {
      return;
    }
    this.current = entity;
    this.notify();
  }

  /** Subscribes to selection changes; returns an unsubscribe. */
  public subscribe(listener: SelectionListener): () => void {
    return this.changed.on(listener);
  }

  private notify(): void {
    this.changed.emit();
  }
}
