import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import {
  registerStandardRenderNodes,
  registerStandardBehaviorNodes,
} from "../../src/engine/nodes-std/index";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";
import { registerManualBehaviorNodes } from "../../src/engine/behavior/nodes/FXManualBehaviorNodes";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import {
  buildParticleUpdateKernel,
  compileParticleBehavior,
  previewParticleBehaviorHash,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

function renderRegistry(): FXNodeRegistry<FXRenderNode> {
  const r = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(r);
  registerManualRenderNodes(r);
  return r;
}
function behaviorRegistry(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  registerManualBehaviorNodes(r);
  return r;
}
function renderGraph(
  nodes: Map<string, FXRenderNode>,
  out: readonly FXOutputBinding[],
  connections: readonly FXConnection[] = [],
): FXGraph<FXRenderNode> {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({ nodes, connections, outputBindings: out });
  return graph;
}

describe("param nodes - named runtime-tunable uniforms/bindings", () => {
  const compiler = new FXCompilerBaseline();

  it("timeline-value (render) allocates a uniform at the stable slot with the default value", () => {
    const r = renderRegistry();
    const a = r.create("timeline-value", { name: "intensity", type: "vec4", value: [1, 0, 0, 1] });
    const shader = compiler.compile(
      renderGraph(new Map([["a", a]]), [bind("albedo", "a", "out")]),
      FX_PARTICLE_TARGET,
    );
    expect(shader.uniformDeclarations).toContain("uniform vec4 u_param_intensity;");
    expect(shader.uniforms["u_param_intensity"]).toBeDefined();
    expect(shader.uniforms["u_param_intensity"].value).toEqual([1, 0, 0, 1]);
  });

  it("two same-named timeline-values share one uniform (dedup); different types clash", () => {
    const r = renderRegistry();
    const a = r.create("timeline-value", { name: "tint", type: "vec4", value: [1, 1, 1, 1] });
    const b = r.create("timeline-value", { name: "tint", type: "vec4", value: [1, 1, 1, 1] });
    // Both feed distinct inputs of a blend node but name the same asset -> one shared uniform.
    const shader = compiler.compile(
      renderGraph(
        new Map([
          ["a", a],
          ["b", b],
          ["mix", r.create("blend", {})],
        ]),
        [bind("albedo", "mix", "color")],
        [
          { from: { nodeId: "a", socketKey: "out" }, to: { nodeId: "mix", socketKey: "base" } },
          { from: { nodeId: "b", socketKey: "out" }, to: { nodeId: "mix", socketKey: "blend" } },
        ],
      ),
      FX_PARTICLE_TARGET,
    );
    expect(Object.keys(shader.uniforms).filter((n) => n === "u_param_tint")).toHaveLength(1);

    // A same-named asset of a different GLSL type is a compile error (vec4 vs float).
    const clash = r.create("timeline-value", { name: "tint", type: "float", value: 0 });
    const compose = r.create("compose-transform", {});
    expect(() =>
      compiler.compile(
        renderGraph(
          new Map([
            ["a", a],
            ["c", clash],
            ["compose", compose],
          ]),
          [bind("albedo", "a", "out"), bind("particleTransform", "compose", "out")],
          [
            {
              from: { nodeId: "c", socketKey: "out" },
              to: { nodeId: "compose", socketKey: "position" },
            },
          ],
        ),
        FX_PARTICLE_TARGET,
      ),
    ).toThrow(/declared as both/);
  });

  it("editing a timeline-value's default rebinds (hash stable); renaming recompiles", () => {
    const r = renderRegistry();
    const a = r.create("timeline-value", { name: "power", type: "float", value: 1 });
    const compose = r.create("compose-transform", {});
    const graph = renderGraph(
      new Map([
        ["a", a],
        ["compose", compose],
      ]),
      [bind("particleTransform", "compose", "out")],
      [
        {
          from: { nodeId: "a", socketKey: "out" },
          to: { nodeId: "compose", socketKey: "position" },
        },
      ],
    );
    const before = compiler.previewHash(graph, FX_PARTICLE_TARGET);

    // The default value is a live uniform -> editing it does NOT change the structural hash.
    a.applyParams?.({ name: "power", type: "float", value: 4 });
    expect(compiler.previewHash(graph, FX_PARTICLE_TARGET)).toBe(before);

    // The name is the uniform's slot -> renaming recompiles.
    a.applyParams?.({ name: "strength", type: "float", value: 4 });
    expect(compiler.previewHash(graph, FX_PARTICLE_TARGET)).not.toBe(before);
  });

  it("texture declares an external sampler and samples it at uv", () => {
    const r = renderRegistry();
    const t = r.create("texture", { name: "mask" });
    const shader = compiler.compile(
      renderGraph(new Map([["t", t]]), [bind("albedo", "t", "color")]),
      FX_PARTICLE_TARGET,
    );
    expect(shader.uniformDeclarations).toContain("uniform sampler2D u_param_mask;");
    // The handle is flagged external so the assembler emits `{ type: "sampler2D", external }`.
    expect(shader.uniforms["u_param_mask"].external).toBe("u_param_mask");
    expect(shader.fragment.body.join("\n")).toContain("texture2D(u_param_mask");
  });

  it("texture with no chosen asset compiles to transparent, allocating no sampler", () => {
    const r = renderRegistry();
    // An unset (and an empty-string) name is the quiescent default, not an error.
    for (const name of [undefined, ""]) {
      const t = r.create("texture", { name });
      const shader = compiler.compile(
        renderGraph(new Map([["t", t]]), [bind("albedo", "t", "color")]),
        FX_PARTICLE_TARGET,
      );
      expect(shader.uniformDeclarations.join("\n")).not.toContain("sampler2D");
      expect(shader.fragment.body.join("\n")).not.toContain("texture2D");
    }
  });

  it("timeline-value (behavior) captures a live binding whose value reaches the buffer", () => {
    const r = behaviorRegistry();
    const a = r.create("timeline-value", { name: "speed", type: "float", value: 7 });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["a", a]]),
      connections: [],
      outputBindings: [bind("positionX", "a", "out")],
    });
    const compiled = compileParticleBehavior(graph);
    expect(compiled.update.bindings["b_param_speed"]).toBeDefined();
    expect(compiled.update.bindings["b_param_speed"].value).toBe(7);

    const buffers = { position: new Float32Array(3), lifecycle: Float32Array.from([0, 1]) };
    buildParticleUpdateKernel(compiled)(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers.position[0]).toBe(7);
  });

  it("timeline-value (behavior) scalarizes a vector into per-component bindings", () => {
    const r = behaviorRegistry();
    const a = r.create("timeline-value", { name: "wind", type: "vec3", value: [1, 2, 3] });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["a", a]]),
      connections: [],
      outputBindings: [bind("position", "a", "out")],
    });
    const compiled = compileParticleBehavior(graph);
    expect(compiled.update.bindings["b_param_wind_x"].value).toBe(1);
    expect(compiled.update.bindings["b_param_wind_y"].value).toBe(2);
    expect(compiled.update.bindings["b_param_wind_z"].value).toBe(3);
  });

  it("editing a behavior timeline-value's default rebinds (hash stable)", () => {
    const r = behaviorRegistry();
    const a = r.create("timeline-value", { name: "speed", type: "float", value: 1 });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map([["a", a]]),
      connections: [],
      outputBindings: [bind("positionX", "a", "out")],
    });
    const before = previewParticleBehaviorHash(graph);
    a.applyParams?.({ name: "speed", type: "float", value: 9 });
    expect(previewParticleBehaviorHash(graph)).toBe(before);
  });

  it("a fresh (unnamed) timeline-value is rejected as a bad param", () => {
    const r = renderRegistry();
    expect(() => r.create("timeline-value", { type: "float", value: 0 })).toThrow();
  });
});
