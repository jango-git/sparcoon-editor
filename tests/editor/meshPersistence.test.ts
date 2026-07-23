import { afterEach, describe, expect, it, vi } from "vitest";

const loadSourceMock = vi.fn<() => unknown>();
vi.mock("../../src/persistence/localStore", () => ({
  loadSource: (): unknown => loadSourceMock(),
  saveSource: (): void => undefined,
}));

// Imported after the mock so loadInitialState picks up the mocked loadSource.
const { loadInitialState } = await import("../../src/persistence/loadState");

/** A minimal persisted scene with one emitter (the doc requires >= 1) plus the given meshes. */
function persistedScene(
  meshes: unknown,
  activeMeshId?: unknown,
  activeGraphKind?: unknown,
): unknown {
  return {
    scene: {
      vfx: { id: "vfx_1", name: "VFX" },
      emitters: [{ id: "emitter_1", name: "Emitter" }],
      activeEmitterId: "emitter_1",
      meshes,
      activeMeshId,
      activeGraphKind,
    },
    assets: [],
    timeline: { duration: 5, fps: 30 },
  };
}

afterEach(() => {
  loadSourceMock.mockReset();
});

describe("VFX mesh persistence normalization", () => {
  it("defaults meshes to an empty list for a document authored before they existed", async () => {
    loadSourceMock.mockReturnValue(persistedScene(undefined));
    const scene = (await loadInitialState()).source.scene;
    expect(scene.meshes).toEqual([]);
    expect(scene.activeMeshId).toBeUndefined();
  });

  it("round-trips a well-formed mesh and resolves the active id + graph kind", async () => {
    loadSourceMock.mockReturnValue(
      persistedScene(
        [{ id: "mesh_7", name: "Shield", transform: { position: [1, 0, 0] } }],
        "mesh_7",
        "vfxMesh",
      ),
    );
    const scene = (await loadInitialState()).source.scene;
    expect(scene.meshes).toHaveLength(1);
    expect(scene.meshes[0].id).toBe("mesh_7");
    expect(scene.meshes[0].name).toBe("Shield");
    expect(scene.meshes[0].transform.position).toEqual([1, 0, 0]);
    // A mesh always carries its render sink after normalization.
    expect(scene.meshes[0].renderGraph.outputBindings.length).toBeGreaterThanOrEqual(0);
    expect(scene.activeMeshId).toBe("mesh_7");
    // The persisted graph-owner kind survives because its mesh survives.
    expect(scene.activeGraphKind).toBe("vfxMesh");
  });

  it("drops a dangling vfxMesh graph kind when no mesh survives", async () => {
    loadSourceMock.mockReturnValue(persistedScene(undefined, "gone", "vfxMesh"));
    const scene = (await loadInitialState()).source.scene;
    expect(scene.meshes).toEqual([]);
    expect(scene.activeGraphKind).toBe("emitter");
  });

  it("drops a corrupt mesh and falls back a stale active id", async () => {
    loadSourceMock.mockReturnValue(persistedScene([{ name: "no id" }, { id: "mesh_1" }], "gone"));
    const scene = (await loadInitialState()).source.scene;
    expect(scene.meshes).toHaveLength(1);
    expect(scene.meshes[0].id).toBe("mesh_1");
    // Active id was stale -> falls to the first surviving mesh.
    expect(scene.activeMeshId).toBe("mesh_1");
  });

  it("prunes a stale particle-only binding (particleTransform) from a mesh render graph", async () => {
    loadSourceMock.mockReturnValue(
      persistedScene([
        {
          id: "mesh_1",
          renderGraph: {
            nodes: {},
            outputBindings: [
              { slot: "albedo", from: { nodeId: "n", socketKey: "out" } },
              { slot: "particleTransform", from: { nodeId: "n", socketKey: "out" } },
            ],
          },
        },
      ]),
    );
    const slots = (await loadInitialState()).source.scene.meshes[0].renderGraph.outputBindings.map(
      (binding) => binding.slot,
    );
    expect(slots).toContain("albedo");
    expect(slots).not.toContain("particleTransform");
  });
});
