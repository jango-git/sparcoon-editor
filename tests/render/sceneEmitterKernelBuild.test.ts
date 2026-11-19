import { FXWorld } from "sparcoon";
import type * as sparcoonEditor from "sparcoon/editor";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Store } from "../../src/model/store";
import type { SceneEmitters } from "../../src/render/sceneEmitters";
import { createPreview, destroyPreviews } from "../helpers/previewScene";
import { createTestState } from "../helpers/testDocument";

/** The kernel programs the preview sent off: whether they build, and how many claims are held. */
const kernelBuilds = vi.hoisted(() => ({ building: true, claims: 0, prepared: 0 }));

vi.mock("sparcoon/editor", async (importOriginal) => {
  const original = await importOriginal<typeof sparcoonEditor>();
  return {
    ...original,
    fxPrepareKernel: () => {
      kernelBuilds.prepared += 1;
      kernelBuilds.claims += 1;
      let released = false;
      return {
        get building(): boolean {
          return kernelBuilds.building;
        },
        release: (): void => {
          if (!released) {
            released = true;
            kernelBuilds.claims -= 1;
          }
        },
      };
    },
  };
});

afterEach(() => {
  destroyPreviews();
  kernelBuilds.building = true;
  kernelBuilds.claims = 0;
  kernelBuilds.prepared = 0;
});

function preview(): { store: Store; emitters: SceneEmitters; emitterId: string } {
  const store = new Store(createTestState());
  // The default emitter tries the GPU simulation, and the stub claims WebGL2.
  const emitters = createPreview({ webgl2: true });
  return { store, emitters, emitterId: store.getSource().scene.emitters[0].id };
}

function spawnedCount(emitters: SceneEmitters, emitterId: string): number {
  emitters.spawn(emitterId, { kind: "burst", count: 32 });
  FXWorld.update(0);
  return emitters.totalParticleCount();
}

describe("SceneEmitters: a rebuild waiting for its GPU kernel to build", () => {
  it("builds no emitter while the kernel builds, and asks for a sync once it has built", () => {
    const { store, emitters, emitterId } = preview();
    const pending = emitters.sync(store.getSource().scene);
    expect(pending.emitterRebuilt).not.toBe(true);
    expect(pending.behaviorStatus.status).not.toBe("invalid");
    expect(spawnedCount(emitters, emitterId)).toBe(0);
    expect(emitters.checkPrograms()).toBe(false);

    kernelBuilds.building = false;
    expect(emitters.checkPrograms()).toBe(true);
    expect(emitters.checkPrograms()).toBe(false);

    const built = emitters.sync(store.getSource().scene);
    expect(built.emitterRebuilt).toBe(true);
    expect(spawnedCount(emitters, emitterId)).toBe(32);
    expect(kernelBuilds.claims).toBe(0);
  });

  it("rebuilds at once when the kernel has built already, holding no claim after", () => {
    kernelBuilds.building = false;
    const { store, emitters, emitterId } = preview();
    expect(emitters.sync(store.getSource().scene).emitterRebuilt).toBe(true);
    expect(spawnedCount(emitters, emitterId)).toBe(32);
    expect(kernelBuilds.prepared).toBe(1);
    expect(kernelBuilds.claims).toBe(0);
    expect(emitters.checkPrograms()).toBe(false);
  });

  it("lets the claim go when the view is destroyed mid-build", () => {
    const { store, emitters } = preview();
    emitters.sync(store.getSource().scene);
    expect(kernelBuilds.claims).toBe(1);
    emitters.destroy();
    expect(kernelBuilds.claims).toBe(0);
  });
});
