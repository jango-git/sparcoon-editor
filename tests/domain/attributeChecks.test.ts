import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Scene, Texture, type WebGLRenderer } from "three";
import { unwrittenAttributeWarnings } from "../../src/domain/attributeChecks";
import type { EditorGraph } from "../../src/domain/graphModel";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXRenderNodeCustomAttribute } from "../../src/engine/render/nodes/FXRenderNodeCustomAttribute";
import {
  createDefaultEmitter,
  createDefaultTrailGraph,
  type EmitterDoc,
} from "../../src/model/editorState";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { compileEmitter } from "../../src/persistence/exportCompile";
import { SceneEmitters } from "../../src/render/sceneEmitters";
import { createTestState } from "../helpers/testDocument";

const NEVER_WRITTEN = /attribute "heat" is read here but the behavior never writes it/;

/** `graph` with a `heat` (vec4) read, `heatRead`, as its albedo. */
function readingHeat(graph: EditorGraph): EditorGraph {
  return {
    ...graph,
    nodes: {
      ...graph.nodes,
      heatRead: {
        id: "heatRead",
        type: "custom-attribute",
        parameters: { name: "heat", type: "vec4" },
        position: { x: 0, y: 0 },
      },
    },
    outputBindings: [
      ...graph.outputBindings.filter((binding) => binding.slot !== "albedo"),
      { slot: "albedo", from: { nodeId: "heatRead", socketKey: "value" } },
    ],
  };
}

/**
 * The starter emitter declaring a `heat` vec4 attribute that its render graph (and, with `trail`,
 * its trail graph) reads - and that its behavior writes only when `written`.
 */
function heatEmitter({ written, trail }: { written: boolean; trail: boolean }): EmitterDoc {
  const emitter = createDefaultEmitter("emitter_1", "Heat");
  const behavior = emitter.behaviorGraph;
  return {
    ...emitter,
    behaviorGraph: {
      ...behavior,
      attributes: [{ name: "heat", type: "vec4" }],
      ...(written
        ? {
            nodes: {
              ...behavior.nodes,
              heatWrite: {
                id: "heatWrite",
                type: "constant",
                parameters: { type: "vec4", value: [1, 0, 0, 1] },
                position: { x: 0, y: 0 },
              },
            },
            outputBindings: [
              ...behavior.outputBindings,
              {
                slot: "attr:heat",
                from: { nodeId: "heatWrite", socketKey: "out" },
                phase: "spawn" as const,
              },
            ],
          }
        : {}),
    },
    renderGraph: readingHeat(emitter.renderGraph),
    ...(trail ? { trailGraph: readingHeat(createDefaultTrailGraph()) } : {}),
  };
}

describe("unwrittenAttributeWarnings", () => {
  const graph = (): FXGraph<FXRenderNode> => {
    const result = new FXGraph<FXRenderNode>();
    result.ingest({
      nodes: new Map<string, FXRenderNode>([
        ["b", new FXRenderNodeCustomAttribute("heat", FX_VALUE_TYPES.vec4)],
        ["a", new FXRenderNodeCustomAttribute("heat", FX_VALUE_TYPES.vec4)],
        ["loose", new FXRenderNodeCustomAttribute("cold", FX_VALUE_TYPES.vec4)],
      ]),
      connections: [],
      outputBindings: [
        { slot: "albedo", from: { nodeId: "b", socketKey: "value" } },
        { slot: "emissive", from: { nodeId: "a", socketKey: "value" } },
      ],
    });
    return result;
  };
  const declared = [
    { name: "heat", type: "vec4" as const },
    { name: "cold", type: "vec4" as const },
  ];

  it("warns once per attribute, on its first reading node by id", () => {
    const warnings = unwrittenAttributeWarnings(graph(), new Set(), declared);
    // `cold`'s read is unreachable, so it counts for nothing.
    expect(warnings).toEqual([
      {
        code: "attribute-never-written",
        message: 'attribute "heat" is read here but the behavior never writes it - it is always 0',
        nodeId: "a",
        params: { name: "heat" },
      },
    ]);
  });

  it("finds nothing for a written attribute, or one the emitter does not declare", () => {
    expect(unwrittenAttributeWarnings(graph(), new Set(["heat"]), declared)).toEqual([]);
    expect(unwrittenAttributeWarnings(graph(), new Set(), [])).toEqual([]);
  });
});

describe("export: a read of an attribute nothing writes", () => {
  it("still exports, warning on the render and the trail graph's reading node", () => {
    const ir = compileEmitter(heatEmitter({ written: false, trail: true }));
    expect(ir.warnings.map((warning) => [warning.code, warning.nodeId])).toEqual([
      ["attribute-never-written", "heatRead"],
    ]);
    expect(ir.warnings[0]?.message).toMatch(NEVER_WRITTEN);
    expect(ir.trail?.warnings.map((warning) => [warning.code, warning.nodeId])).toEqual([
      ["attribute-never-written", "heatRead"],
    ]);
  });

  it("warns about nothing once the behavior writes it", () => {
    const ir = compileEmitter(heatEmitter({ written: true, trail: true }));
    expect(ir.warnings).toEqual([]);
    expect(ir.trail?.warnings).toEqual([]);
  });
});

describe("live preview: a read of an attribute nothing writes", () => {
  function sync(emitter: EmitterDoc) {
    const state = createTestState();
    state.source = {
      ...state.source,
      scene: { ...state.source.scene, emitters: [emitter], activeEmitterId: emitter.id },
    };
    const store = new Store(state, new SignalBus());
    const renderer = { capabilities: { isWebGL2: false } } as unknown as WebGLRenderer;
    const emitters = new SceneEmitters(
      new Scene(),
      () => new Texture(),
      new PerspectiveCamera(),
      renderer,
      "baseline",
      () => 0,
    );
    const result = emitters.sync(store.getSource().scene);
    emitters.destroy();
    return result;
  }

  it("runs the graphs, with the same warning the export finds", () => {
    const result = sync(heatEmitter({ written: false, trail: true }));
    expect(result.renderStatus.status).not.toBe("invalid");
    expect(result.renderStatus.warnings).toEqual([expect.stringMatching(NEVER_WRITTEN)]);
    expect(result.trailStatus?.status).not.toBe("invalid");
    expect(result.trailStatus?.warnings).toEqual([expect.stringMatching(NEVER_WRITTEN)]);
  });

  it("warns about nothing once the behavior writes it", () => {
    const result = sync(heatEmitter({ written: true, trail: true }));
    expect(result.renderStatus.warnings ?? []).toEqual([]);
    expect(result.trailStatus?.warnings ?? []).toEqual([]);
  });
});
