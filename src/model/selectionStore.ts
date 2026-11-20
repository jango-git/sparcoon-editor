/** The entity the gizmo and hotkeys act on. Not part of the document or history. */

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

  public selectVfx(): void {
    this.set(VFX_ENTITY);
  }

  public selectEmitter(id: string): void {
    this.set(emitterEntity(id));
  }

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

  public subscribe(listener: SelectionListener): () => void {
    return this.changed.on(listener);
  }

  private notify(): void {
    this.changed.emit();
  }
}
