/**
 * The SDF bake under way in the baker: which mesh asset, the settings, the last bake and the
 * surface level it is shown at. Transient like the selection - nothing of it is in the document
 * until a bake is added to the library, and it ends with that or when it is closed.
 */

import { Ferrsign0 } from "ferrsign";

import {
  bakeSettingsProblem,
  bakeVolume,
  defaultBakeSettings,
  fitBox,
  isClosedMesh,
  type VolumeBakeResult,
  type VolumeBakeSettings,
} from "../domain/volumeBake";
import { addVolumeAsset } from "./commands";
import type { MeshAsset } from "./editorState";
import type { Store } from "./store";
import { volumeAssetOf } from "./volumeAssets";

/** A session's state while it runs. */
export interface VolumeBakeState {
  readonly mesh: MeshAsset;
  /** Whether the mesh is closed, so has an inside to bake as a solid. */
  readonly closed: boolean;
  readonly settings: VolumeBakeSettings;
  /** The last bake of these settings; absent before one, and once they change. */
  readonly baked: VolumeBakeResult | undefined;
  /** The share of the bake under way done, `0..1`; absent when none is. */
  readonly progress: number | undefined;
  /** The distance the baked surface is shown at: 0 is the surface itself. */
  readonly level: number;
}

export class VolumeBakeSession {
  private current: VolumeBakeState | undefined;
  private bake: AbortController | undefined;
  private readonly changed = new Ferrsign0();

  constructor(private readonly store: Store) {}

  /** The session's state; absent while none runs. */
  public get(): VolumeBakeState | undefined {
    return this.current;
  }

  /** Starts baking `mesh` afresh, from its default settings, ending a session already running. */
  public start(mesh: MeshAsset): void {
    this.stopBake();
    const closed = isClosedMesh(mesh.geometry);
    this.current = {
      mesh,
      closed,
      settings: defaultBakeSettings(mesh.geometry, closed),
      baked: undefined,
      progress: undefined,
      level: 0,
    };
    this.changed.emit();
  }

  /** Starts the session's mesh afresh: its default settings, no bake, the surface at 0. */
  public reset(): void {
    if (this.current !== undefined) {
      this.start(this.current.mesh);
    }
  }

  /** Ends the session, stopping a bake under way and dropping what it baked. */
  public close(): void {
    if (this.current === undefined) {
      return;
    }
    this.stopBake();
    this.current = undefined;
    this.changed.emit();
  }

  /** Changes the settings, a valid change only; the last bake no longer matches them. */
  public setSettings(patch: Partial<VolumeBakeSettings>): void {
    const current = this.current;
    if (current === undefined) {
      return;
    }
    const settings = { ...current.settings, ...patch };
    if (bakeSettingsProblem(settings) !== undefined) {
      this.changed.emit();
      return;
    }
    this.stopBake();
    this.update({ settings, baked: undefined, progress: undefined });
  }

  /** Fits the box to the mesh, padded by the band. */
  public fitBox(): void {
    const current = this.current;
    if (current !== undefined) {
      this.setSettings(fitBox(current.mesh.geometry, current.settings.band));
    }
  }

  public setLevel(level: number): void {
    if (this.current !== undefined && Number.isFinite(level)) {
      this.update({ level });
    }
  }

  /** Bakes the settings, stopping a bake under way first. */
  public async runBake(): Promise<void> {
    const current = this.current;
    if (current === undefined) {
      return;
    }
    this.stopBake();
    const controller = new AbortController();
    this.bake = controller;
    this.update({ baked: undefined, progress: 0 });
    try {
      const baked = await bakeVolume(current.mesh.geometry, current.settings, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (this.bake === controller) {
            this.update({ progress });
          }
        },
      });
      if (this.bake === controller) {
        this.bake = undefined;
        this.update({ baked, progress: undefined });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn("VolumeBakeSession: the bake failed", error);
        this.bake = undefined;
        this.update({ progress: undefined });
      }
    }
  }

  /** Stops the bake under way, keeping the session. */
  public stopBake(): void {
    if (this.bake === undefined) {
      return;
    }
    this.bake.abort();
    this.bake = undefined;
    if (this.current !== undefined) {
      this.update({ progress: undefined });
    }
  }

  /** Adds the last bake to the library as a volume asset, and ends the session. */
  public async addToLibrary(): Promise<void> {
    const current = this.current;
    const baked = current?.baked;
    if (current === undefined || baked === undefined) {
      return;
    }
    const asset = await volumeAssetOf(this.store.getSource(), current.mesh, baked);
    // Closed, restarted or rebaked while the atlas was encoded: that state owns what happens now.
    if (this.current?.baked !== baked) {
      return;
    }
    addVolumeAsset(this.store, asset);
    this.close();
  }

  /** Subscribes to session changes; returns an unsubscribe. */
  public subscribe(listener: () => void): () => void {
    return this.changed.on(listener);
  }

  private update(patch: Partial<VolumeBakeState>): void {
    if (this.current !== undefined) {
      this.current = { ...this.current, ...patch };
      this.changed.emit();
    }
  }
}
