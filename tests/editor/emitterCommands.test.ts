import { describe, expect, it } from "vitest";
import { createInitialState } from "../../src/model/editorState";
import { Store } from "../../src/model/store";
import { SignalBus } from "../../src/model/signals";
import { isSink } from "../../src/domain/sinks";
import {
  addCatalogNode,
  addEmitter,
  removeEmitter,
  renameEmitter,
  selectEmitter,
} from "../../src/model/commands";
import { withFreshIds } from "../../src/model/commands/emitterCommands";
import { createEmptyGraph } from "../../src/domain/graphModel";
import {
  selectActiveEmitter,
  selectActiveEmitterId,
  selectBehaviorGraph,
  selectEmitters,
} from "../../src/model/selectors";

const freshStore = (): Store => new Store(createInitialState(), new SignalBus());

/** The authored (non-sink) node ids across both of an emitter's graphs. */
function authoredNodeIds(store: Store, id: string): string[] {
  const emitter = selectEmitters(store).find((candidate) => candidate.id === id)!;
  return [
    ...Object.values(emitter.renderGraph.nodes),
    ...Object.values(emitter.behaviorGraph.nodes),
  ]
    .filter((node) => !isSink(node))
    .map((node) => node.id);
}

describe("emitter commands", () => {
  it("addEmitter appends a fresh emitter and makes it active", () => {
    const store = freshStore();
    expect(selectEmitters(store)).toHaveLength(1);

    const id = addEmitter(store);

    const emitters = selectEmitters(store);
    expect(emitters).toHaveLength(2);
    expect(emitters[1].id).toBe(id);
    expect(selectActiveEmitterId(store)).toBe(id);
    expect(emitters[1].name).toBe("Emitter 2");
  });

  it("gives a new emitter its own freshly-minted authored node ids (no collision)", () => {
    const store = freshStore();
    const firstId = selectActiveEmitterId(store);
    const secondId = addEmitter(store);

    const firstAuthored = authoredNodeIds(store, firstId);
    const secondAuthored = authoredNodeIds(store, secondId);
    expect(secondAuthored.length).toBeGreaterThan(0);
    // Every authored node id in the new emitter is distinct from the original's.
    for (const id of secondAuthored) {
      expect(firstAuthored).not.toContain(id);
    }
    // The new emitter still carries the same visible default effect (a live behavior graph).
    expect(selectBehaviorGraph(store).outputBindings.length).toBeGreaterThan(0);
  });

  it("edits the active emitter's graph in isolation from the others", () => {
    const store = freshStore();
    const firstId = selectActiveEmitterId(store);
    addEmitter(store); // now active

    addCatalogNode(store, "behaviorGraph", "constant", { x: 0, y: 0 });

    const first = selectEmitters(store).find((emitter) => emitter.id === firstId)!;
    const active = selectActiveEmitter(store);
    // The new node landed only on the active emitter's behavior graph.
    const constants = (graphNodes: Record<string, { type: string }>): number =>
      Object.values(graphNodes).filter((node) => node.type === "constant").length;
    expect(constants(active.behaviorGraph.nodes)).toBe(1);
    expect(constants(first.behaviorGraph.nodes)).toBe(0);
  });

  it("selectEmitter changes the active target; unknown/current ids are no-ops", () => {
    const store = freshStore();
    const firstId = selectActiveEmitterId(store);
    const secondId = addEmitter(store);

    selectEmitter(store, firstId);
    expect(selectActiveEmitterId(store)).toBe(firstId);

    // Re-selecting the active one, or an unknown id, leaves the selection untouched.
    selectEmitter(store, firstId);
    selectEmitter(store, "nope");
    expect(selectActiveEmitterId(store)).toBe(firstId);

    selectEmitter(store, secondId);
    expect(selectActiveEmitterId(store)).toBe(secondId);
  });

  it("removeEmitter drops an emitter and refuses to remove the last one", () => {
    const store = freshStore();
    const firstId = selectActiveEmitterId(store);
    const secondId = addEmitter(store);

    removeEmitter(store, secondId);
    expect(selectEmitters(store)).toHaveLength(1);
    // Removing the active emitter falls back to a surviving neighbour.
    expect(selectActiveEmitterId(store)).toBe(firstId);

    removeEmitter(store, firstId); // last emitter - no-op
    expect(selectEmitters(store)).toHaveLength(1);
  });

  it("removeEmitter keeps the active selection when a different emitter is removed", () => {
    const store = freshStore();
    const firstId = selectActiveEmitterId(store);
    const secondId = addEmitter(store); // active

    removeEmitter(store, firstId);
    expect(selectEmitters(store)).toHaveLength(1);
    expect(selectActiveEmitterId(store)).toBe(secondId);
  });

  it("renameEmitter renames an emitter and rejects a blank name", () => {
    const store = freshStore();
    const id = selectActiveEmitterId(store);

    renameEmitter(store, id, "  Sparks  ");
    expect(selectActiveEmitter(store).name).toBe("Sparks");

    renameEmitter(store, id, "   ");
    expect(selectActiveEmitter(store).name).toBe("Sparks");
  });

  it("withFreshIds re-mints comment ids too, not just node/connection ids", () => {
    const graph = {
      ...createEmptyGraph(),
      comments: [{ id: "comment_1", text: "note", position: { x: 0, y: 0 }, size: { w: 1, h: 1 } }],
    };

    const fresh = withFreshIds(graph);

    expect(fresh.comments).toHaveLength(1);
    expect(fresh.comments[0].id).not.toBe("comment_1");
    expect(fresh.comments[0].text).toBe("note");
  });

  it("adds emitters through history so add/remove is undoable", () => {
    const store = freshStore();
    addEmitter(store);
    expect(selectEmitters(store)).toHaveLength(2);

    store.undo();
    expect(selectEmitters(store)).toHaveLength(1);

    store.redo();
    expect(selectEmitters(store)).toHaveLength(2);
  });
});
