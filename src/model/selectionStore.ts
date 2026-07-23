/**
 * The transform selection: which scene entity (VFX group or one emitter/mesh) the preview gizmo
 * and hotkeys target. Transient like the transport - editor focus, never in the model/history/saved doc.
 */

import { emitterEntity, sameEntity, vfxMeshEntity, VFX_ENTITY, type SceneEntity } from "./entity";

export type SelectionListener = () => void;

export class SelectionStore {
  private current: SceneEntity = VFX_ENTITY;
  private readonly listeners = new Set<SelectionListener>();

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
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
