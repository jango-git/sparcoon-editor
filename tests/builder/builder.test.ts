import { describe, expect, it } from "vitest";
import {
  buildBehaviorGraph,
  buildRenderGraph,
  FXGraphBuilder,
} from "../../src/engine/builder/FXGraphBuilder";
import { FX_SNAPSHOT_VERSION } from "../../src/engine/core/live/FXSnapshotData";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  buildParticleSpawnKernel,
  compileParticleBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { registerManualBehaviorNodes } from "../../src/engine/behavior/nodes/FXManualBehaviorNodes";
import { FX_LIFETIME } from "sparcoon";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";
import { attributeSlot } from "../helpers/attr";

describe("FXGraphBuilder - deterministic ids + wiring", () => {
  it("stamps the current snapshot version", () => {
    const data = buildRenderGraph((b) => {
      b.bind("albedo", b.add("constant", { type: "vec4", value: [1, 1, 1, 1] }).out("out"));
    });
    expect(data.version).toBe(FX_SNAPSHOT_VERSION);
  });

  it("generates ids as `${type}#${index}` with a per-type counter", () => {
    const data = buildRenderGraph((b) => {
      b.add("constant", { type: "float", value: 1 });
      b.add("constant", { type: "float", value: 2 });
      b.add("spherical-clip", {});
    });
    expect(Object.keys(data.nodes).sort()).toEqual([
      "constant#0",
      "constant#1",
      "spherical-clip#0",
    ]);
  });

  it("re-running the same builder yields an identical snapshot (stable ids -> rebind)", () => {
    const build = (): unknown =>
      buildBehaviorGraph((b) => {
        const grav = b.add("gravity", { acceleration: [0, -1, 0] });
        b.bind("velocity", grav.out("velocity"));
      });
    expect(build()).toEqual(build());
  });

  it("records the inputs map as connections and bind() as output bindings", () => {
    const data = buildRenderGraph((b) => {
      const color = b.add("constant", { type: "vec4", value: [0.5, 0.5, 0.6, 1] });
      const clip = b.add("spherical-clip", { innerRadius: 0.2 }, { color: color.out("out") });
      b.bind("albedo", clip.out("color"));
    });
    expect(data.connections).toEqual([
      {
        from: { nodeId: "constant#0", socketKey: "out" },
        to: { nodeId: "spherical-clip#0", socketKey: "color" },
      },
    ]);
    expect(data.outputBindings).toEqual([
      { slot: "albedo", from: { nodeId: "spherical-clip#0", socketKey: "color" } },
    ]);
  });

  it("pipe() sugar resolves default sockets from node metadata", () => {
    const data = buildRenderGraph((b) => {
      const color = b.add("constant", { type: "vec4", value: [1, 0, 0, 1] });
      const clip = color.pipe("spherical-clip", { innerRadius: 0.1 });
      b.bind("albedo", clip.out("color"));
    });
    expect(data.connections).toEqual([
      {
        from: { nodeId: "constant#0", socketKey: "out" },
        to: { nodeId: "spherical-clip#0", socketKey: "color" },
      },
    ]);
  });

  it("a bare builder without metadata rejects pipe() unless sockets are explicit", () => {
    const bare = new FXGraphBuilder();
    const handle = bare.add("constant", { type: "vec4", value: [1, 1, 1, 1] });
    expect(() => handle.pipe("spherical-clip")).toThrow(/without node metadata/);
    // Explicit sockets bypass the missing metadata.
    expect(() => handle.pipe("spherical-clip", {}, { from: "out", into: "color" })).not.toThrow();
  });
});

describe("FXGraphBuilder - snapshot compiles on both backends", () => {
  it("render: builder -> snapshot -> reconcile -> compile produces albedo", () => {
    const data = buildRenderGraph((b) => {
      const color = b.add("constant", { type: "vec4", value: [0.5, 0.5, 0.6, 1] });
      const clip = b.add("spherical-clip", { innerRadius: 0.2 }, { color: color.out("out") });
      b.bind("albedo", clip.out("color"));
    });

    const graph = new FXGraph<FXRenderNode>();
    new FXGraphReconciler(renderRegistry()).reconcile(graph, data);
    const shader = new FXCompilerBaseline().compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();
  });

  it("behavior: builder -> snapshot -> reconcile -> compile -> kernel writes lifetime", () => {
    // Executor model: velocity is a user attribute. Spawn seeds it (store-attribute);
    // the update force reads it, integrates gravity and stores it back - both bind to
    // the `attr:velocity` slot in their own phase (a cross-phase edge is illegal).
    const data = buildBehaviorGraph((b) => {
      const life = b.add("lifetime", { min: 3, max: 3 });
      const pos = b.add("spawn-box", { size: [0, 0, 0], center: [0, 0, 0] });
      const vel = b.add("initial-velocity", { direction: [0, 1, 0], speed: [1, 1] });
      const seedVel = b.add(
        "store-attribute",
        { name: "velocity", type: "vec3", phase: "spawn" },
        { value: vel.out("velocity") },
      );
      const readVel = b.add("custom-attribute", {
        name: "velocity",
        type: "vec3",
        phase: "update",
      });
      const grav = b.add(
        "gravity",
        { acceleration: [0, -1, 0] },
        { velocity: readVel.out("value") },
      );
      const storeVel = b.add(
        "store-attribute",
        { name: "velocity", type: "vec3", phase: "update" },
        { value: grav.out("velocity") },
      );
      b.bind("lifetime", life.out("value"));
      b.bind("position", pos.out("position"));
      b.bind(attributeSlot("velocity"), seedVel.out("value"));
      b.bind(attributeSlot("velocity"), storeVel.out("value"));
    });

    const graph = new FXGraph<FXBehaviorNode>();
    const registry = behaviorRegistry();
    registerManualBehaviorNodes(registry);
    new FXGraphReconciler(registry).reconcile(graph, data);
    const compiled = compileParticleBehavior(graph);
    const spawn = buildParticleSpawnKernel(compiled);

    // Core buffers (position vec3, lifecycle vec3) + the velocity attribute buffer.
    const position = new Float32Array(3);
    const lifecycle = new Float32Array(3);
    const velocity = new Float32Array(3);
    spawn({ position, lifecycle, velocity }, 0, 1, compiled.spawn.bindings);
    expect(lifecycle[FX_LIFETIME]).toBe(3); // PARTICLE_LIFETIME
  });
});
