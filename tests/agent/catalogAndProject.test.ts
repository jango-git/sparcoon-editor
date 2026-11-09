import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogApi } from "../../src/agent/catalog";
import { createProjectApi } from "../../src/agent/project";
import { readStatus } from "../../src/agent/status.Internal";
import { isMeshExcludedRenderNode, metaFor, GraphKind } from "../../src/domain/nodePalette";
import { createDefaultEmitter, createInitialState } from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { serializeProject } from "../../src/persistence/projectFile";
import type { DocumentReplaceTarget } from "../../src/persistence/replaceDocument";

describe("agent catalog", () => {
  const catalog = createCatalogApi();

  it("lists each graph's palette and narrows the render one for a mesh host", () => {
    const render = catalog.nodeTypes("render");
    const behavior = catalog.nodeTypes("behavior");
    expect(render.some((entry) => entry.type === "constant")).toBe(true);
    expect(behavior.some((entry) => entry.type === "spawn-sphere")).toBe(true);
    const meshOnly = catalog.nodeTypes("render", { mesh: true });
    expect(meshOnly.length).toBeLessThan(render.length);
    expect(
      meshOnly.every((entry) => !isMeshExcludedRenderNode(metaFor(GraphKind.Render, entry.type)!)),
    ).toBe(true);
  });

  it("describes one type with its sockets and parameters", () => {
    const lifetime = catalog.nodeType("behavior", "lifetime");
    expect(lifetime.outputs.map((socket) => socket.key)).toContain("value");
    // Its range is two editable inputs: the inline value lives in the node's params under the
    // socket key until something is wired in.
    const editable = lifetime.inputs.filter((socket) => socket.control !== undefined);
    expect(editable.map((socket) => socket.key)).toEqual(expect.arrayContaining(["min", "max"]));
    expect(lifetime.label).toBeTruthy();
  });

  it("rejects an unknown type or graph", () => {
    expect(() => catalog.nodeType("render", "no-such-node")).toThrow(/not_found/);
    expect(() => catalog.nodeTypes("material")).toThrow(/invalid_argument/);
  });

  it("returns plain JSON a page.evaluate can carry", () => {
    const described = catalog.nodeType("render", "constant");
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });
});

/** A replace target whose viewport settings only count their resets. */
function replaceTarget(store: Store): DocumentReplaceTarget & { resets: number } {
  const target = {
    store,
    resets: 0,
    previewSettings: { reset: (): void => void (target.resets += 1) },
    gizmoSettings: { reset: (): void => void (target.resets += 1) },
  };
  return target as unknown as DocumentReplaceTarget & { resets: number };
}

describe("agent project", () => {
  it("round-trips the project file as one undoable replace", async () => {
    const original = new Store(createInitialState(), new SignalBus());
    const state = createInitialState();
    state.source = {
      ...state.source,
      name: "Imported",
      scene: { ...state.source.scene, emitters: [createDefaultEmitter("emitter_9", "Nine")] },
    };
    const json = serializeProject(state.source);

    const target = replaceTarget(original);
    const project = createProjectApi(target);
    const loaded = await project.load(json);
    expect(loaded.name).toBe("Imported");
    expect(loaded.emitters.map((emitter) => emitter.id)).toEqual(["emitter_9"]);
    expect(original.getSource().name).toBe("Imported");
    expect(JSON.parse(project.get()).source.scene.emitters[0].id).toBe("emitter_9");
    expect(target.resets).toBe(2);
    original.undo();
    expect(original.getSource().name).toBe("");
  });

  it("rejects unreadable project text and unknown presets", async () => {
    const project = createProjectApi(
      replaceTarget(new Store(createInitialState(), new SignalBus())),
    );
    await expect(project.load("{ nope")).rejects.toThrow(/invalid_argument/);
    await expect(project.loadPreset("missing")).rejects.toThrow(/not_found/);
    expect(project.presets()).toEqual(expect.arrayContaining(["empty", "sparks"]));
  });

  it("names the project, which names the exported class", () => {
    const state = createInitialState();
    state.source = {
      ...state.source,
      scene: { ...state.source.scene, emitters: [createDefaultEmitter("emitter_1", "Emitter")] },
    };
    const store = new Store(state, new SignalBus());
    const project = createProjectApi(replaceTarget(store));
    project.setName("bolt sparks");
    expect(store.getSource().name).toBe("bolt sparks");
    expect(project.exportTypeScript()).toMatch(/class BoltSparks\b/);
    expect(() => project.setName(3 as never)).toThrow(/invalid_argument/);
  });
});

describe("agent status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("focuses the asked owner and reads its derived status", async () => {
    const state = createInitialState();
    state.source = {
      ...state.source,
      scene: {
        ...state.source.scene,
        emitters: [createDefaultEmitter("emitter_a", "A"), createDefaultEmitter("emitter_b", "B")],
        activeEmitterId: "emitter_a",
      },
    };
    const store = new Store(state, new SignalBus());
    store.setDerived({ renderStatus: { status: "recompiled", messages: [] } });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      setTimeout(() => callback(0), 0);
      return 0;
    });

    const status = await readStatus(store, "emitter_b");
    expect(store.getSource().scene.activeEmitterId).toBe("emitter_b");
    expect(status.ownerId).toBe("emitter_b");
    expect(status.render).toEqual({
      status: "recompiled",
      messages: [],
      warnings: [],
      errors: [],
    });
    await expect(readStatus(store, "emitter_x")).rejects.toThrow(/not_found/);
  });

  it("answers reads in flight at once each for its own owner", async () => {
    const state = createInitialState();
    state.source = {
      ...state.source,
      scene: {
        ...state.source.scene,
        emitters: [createDefaultEmitter("emitter_a", "A"), createDefaultEmitter("emitter_b", "B")],
        activeEmitterId: "emitter_a",
      },
    };
    const store = new Store(state, new SignalBus());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      setTimeout(() => callback(0), 0);
      return 0;
    });

    const [first, missing, second] = await Promise.allSettled([
      readStatus(store, "emitter_a"),
      readStatus(store, "emitter_x"),
      readStatus(store, "emitter_b"),
    ]);
    expect(first.status === "fulfilled" && first.value.ownerId).toBe("emitter_a");
    expect(missing.status).toBe("rejected");
    expect(second.status === "fulfilled" && second.value.ownerId).toBe("emitter_b");
  });

  it("focuses without an undo step, so undo still reaches the last real edit", async () => {
    const state = createInitialState();
    state.source = {
      ...state.source,
      scene: {
        ...state.source.scene,
        emitters: [createDefaultEmitter("emitter_a", "A"), createDefaultEmitter("emitter_b", "B")],
        activeEmitterId: "emitter_a",
      },
    };
    const store = new Store(state, new SignalBus());
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      setTimeout(() => callback(0), 0);
      return 0;
    });
    store.commit({ ...store.getSource(), name: "Edited" }, "view");

    await readStatus(store, "emitter_b");
    expect(store.getSource().scene.activeEmitterId).toBe("emitter_b");
    store.undo();
    expect(store.getSource().name).toBe("");
    expect(store.canUndo).toBe(false);
  });
});
