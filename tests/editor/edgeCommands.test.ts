import { describe, expect, it } from "vitest";
import { bindingSinkId, findIncomingEdge } from "../../src/domain/graphEdges";
import {
  GraphKind,
  RENDER_SINK_ID,
  SPAWN_SINK_ID,
  UPDATE_SINK_ID,
} from "../../src/domain/nodePalette";
import { connectSockets, disconnectInput } from "../../src/model/commands";
import { createDefaultEmitter, createInitialState } from "../../src/model/editorState";
import { selectBehaviorGraph, selectRenderGraph } from "../../src/model/selectors";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";

function starterStore(): Store {
  const state = createInitialState();
  state.source = {
    ...state.source,
    scene: { ...state.source.scene, emitters: [createDefaultEmitter("emitter_1", "Emitter")] },
  };
  return new Store(state, new SignalBus());
}

describe("edge commands", () => {
  it("binds into a sink slot with the sink's phase, and connects between nodes", () => {
    const store = starterStore();
    connectSockets(
      store,
      "behaviorGraph",
      { nodeId: "n_life", socketKey: "value" },
      { nodeId: UPDATE_SINK_ID, socketKey: "lifetime" },
    );
    expect(selectBehaviorGraph(store).outputBindings).toContainEqual({
      slot: "lifetime",
      from: { nodeId: "n_life", socketKey: "value" },
      phase: "update",
    });

    connectSockets(
      store,
      "renderGraph",
      { nodeId: "n_lookat", socketKey: "out" },
      { nodeId: "n_transform", socketKey: "rotation" },
    );
    const incoming = findIncomingEdge(selectRenderGraph(store), {
      nodeId: "n_transform",
      socketKey: "rotation",
    });
    expect(incoming).toMatchObject({ kind: "connection", from: { nodeId: "n_lookat" } });
  });

  it("disconnects whichever edge feeds an input, binding or connection", () => {
    const store = starterStore();
    disconnectInput(store, "renderGraph", { nodeId: RENDER_SINK_ID, socketKey: "albedo" });
    disconnectInput(store, "renderGraph", { nodeId: "n_transform", socketKey: "rotation" });
    const graph = selectRenderGraph(store);
    expect(graph.outputBindings.some((binding) => binding.slot === "albedo")).toBe(false);
    expect(
      findIncomingEdge(graph, { nodeId: "n_transform", socketKey: "rotation" }),
    ).toBeUndefined();
  });

  it("maps a binding back to its sink node", () => {
    expect(bindingSinkId(GraphKind.Render, {})).toBe(RENDER_SINK_ID);
    expect(bindingSinkId(GraphKind.Behavior, { phase: "spawn" })).toBe(SPAWN_SINK_ID);
    expect(bindingSinkId(GraphKind.Behavior, { phase: "update" })).toBe(UPDATE_SINK_ID);
  });
});
