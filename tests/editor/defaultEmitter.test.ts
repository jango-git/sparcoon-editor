import { describe, expect, it } from "vitest";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../../src/engine/nodes-std/index";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";
import { registerManualBehaviorNodes } from "../../src/engine/behavior/nodes/FXManualBehaviorNodes";
import { compileToArtifacts } from "../../src/engine/emit/compileToArtifacts";
import { serializeGraph } from "../../src/domain/serialize";
import { isSink } from "../../src/domain/sinks";
import { createDefaultEmitter, createInitialState } from "../../src/model/editorState";

/**
 * The seeded starter emitter must actually render - otherwise the preview is empty.
 * This walks its two graphs through the exact preview path (serialize -> reconcile ->
 * compileToArtifacts) that `SceneEmitters`/`EmitterView` use, minus the WebGL launch.
 */
describe("default emitter", () => {
  it("its seeded graphs reconcile and compile to a runnable artifact pair", () => {
    const emitter = createDefaultEmitter("e1", "Emitter");

    const renderRegistry = new FXNodeRegistry();
    registerStandardRenderNodes(renderRegistry);
    registerManualRenderNodes(renderRegistry);
    const behaviorRegistry = new FXNodeRegistry();
    registerStandardBehaviorNodes(behaviorRegistry);
    registerManualBehaviorNodes(behaviorRegistry);

    const renderGraph = new FXGraph();
    const behaviorGraph = new FXGraph();
    const renderResult = new FXGraphReconciler(renderRegistry).reconcile(
      renderGraph,
      serializeGraph(emitter.renderGraph),
    );
    const behaviorResult = new FXGraphReconciler(behaviorRegistry).reconcile(
      behaviorGraph,
      serializeGraph(emitter.behaviorGraph),
    );
    expect(renderResult.errors).toEqual([]);
    expect(behaviorResult.errors).toEqual([]);

    const artifacts = compileToArtifacts(renderGraph, behaviorGraph);

    // A real render program (albedo bound) and a behavior kernel that seeds spawn state.
    expect(artifacts.render).toBeDefined();
    expect(artifacts.behavior).toBeDefined();
    expect(typeof artifacts.hash).toBe("string");
  });
});

describe("createInitialState", () => {
  it("is genuinely blank - only the mandatory sink nodes, no starter content", () => {
    const { source } = createInitialState();
    const [emitter] = source.scene.emitters;
    expect(Object.values(emitter.renderGraph.nodes).every(isSink)).toBe(true);
    expect(Object.values(emitter.behaviorGraph.nodes).every(isSink)).toBe(true);
    expect(emitter.events).toEqual([]);
  });
});
