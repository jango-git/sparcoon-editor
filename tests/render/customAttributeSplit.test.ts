import { describe, expect, it } from "vitest";

import { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";
import { FXRenderNodeCustomAttributeSplit } from "../../src/engine/render/nodes/FXRenderNodeCustomAttributeSplit";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import { renderRegistry } from "../helpers/stdRegistry";

const VEC3 = FX_VALUE_TYPES.vec3;
const FLOAT = FX_VALUE_TYPES.float;

/** A registry with the standard render nodes plus the manual ones. */
function renderReg() {
  const registry = renderRegistry();
  registerManualRenderNodes(registry);
  return registry;
}

describe("custom-attribute-split render node", () => {
  it("always declares all four x/y/z/w float outputs, regardless of the source width", () => {
    const node = new FXRenderNodeCustomAttributeSplit("tint", FLOAT);
    expect(node.outputs.map((socket) => socket.key)).toEqual(["x", "y", "z", "w"]);
    expect(node.outputs.every((socket) => socket.type === FLOAT)).toBe(true);
  });
});

describe("custom-attribute-split: editor path (name + type only, no explicit stage)", () => {
  it("validates and compiles a float attribute's x component into a vertex slot", () => {
    const reg = renderReg();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        // Exactly what the editor's attribute picker produces: name + type, no stage.
        ["spin", reg.create("custom-attribute-split", { name: "spin", type: "float" })],
        ["compose", reg.create("compose-transform", {})],
        ["col", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      connections: [
        {
          from: { nodeId: "spin", socketKey: "x" },
          to: { nodeId: "compose", socketKey: "position" },
        },
      ],
      outputBindings: [
        { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
        { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      ],
    });
    const target = buildParticleTarget([{ name: "spin", type: FLOAT }]);
    const result = new FXCompilerBaseline().validate(graph, target);
    expect(result.ok).toBe(true);

    const compiled = new FXCompilerBaseline().compile(graph, target);
    expect(compiled.color.vertex.body.join("\n")).toContain("p_fx_spin");
    expect(compiled.color.fragment.body.join("\n")).not.toContain("p_fx_spin");
  });

  it("compiles a vec3 attribute split into x/y/z, wired into position via combine", () => {
    const reg = renderReg();
    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map<string, FXRenderNode>([
        ["vel", reg.create("custom-attribute-split", { name: "velocity", type: "vec3" })],
        ["combine", reg.create("combine", { type: "vec3" })],
        ["compose", reg.create("compose-transform", {})],
        ["col", reg.create("constant", { type: "color", value: [1, 1, 1, 1] })],
      ]),
      connections: [
        { from: { nodeId: "vel", socketKey: "x" }, to: { nodeId: "combine", socketKey: "x" } },
        { from: { nodeId: "vel", socketKey: "y" }, to: { nodeId: "combine", socketKey: "y" } },
        { from: { nodeId: "vel", socketKey: "z" }, to: { nodeId: "combine", socketKey: "z" } },
        {
          from: { nodeId: "combine", socketKey: "out" },
          to: { nodeId: "compose", socketKey: "position" },
        },
      ],
      outputBindings: [
        { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
        { slot: "albedo", from: { nodeId: "col", socketKey: "out" } },
      ],
    });
    const target = buildParticleTarget([{ name: "velocity", type: VEC3 }]);
    const compiled = new FXCompilerBaseline().compile(graph, target);
    expect(compiled.color.vertex.body.join("\n")).toContain("p_fx_velocity");
  });
});
