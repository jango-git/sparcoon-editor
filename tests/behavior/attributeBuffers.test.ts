import {
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_LIFETIME,
} from "sparcoon";
import { describe, expect, it } from "vitest";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import type {
  FXCompiledKernel,
  FXKernelBufferLayout,
} from "../../src/engine/behavior/FXCompiledKernel";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import {
  attributeSlot,
  buildParticleBehaviorTargets,
} from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXBehaviorNodeStoreAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeStoreAttribute";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXAttributeRequest } from "../../src/engine/core/socket/FXAttribute";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { behaviorRegistry } from "../helpers/stdRegistry";

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;

const reg = behaviorRegistry();

function graphOf(
  nodes: Record<string, FXBehaviorNode>,
  connections: readonly {
    from: { nodeId: string; socketKey: string };
    to: { nodeId: string; socketKey: string };
  }[],
  outputBindings: readonly { slot: string; from: { nodeId: string; socketKey: string } }[],
): FXGraph<FXBehaviorNode> {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({ nodes: new Map(Object.entries(nodes)), connections, outputBindings });
  return graph;
}

/** Fresh core buffers (position vec3 + lifecycle vec3) for `count` particles. */
function coreBuffers(count: number): { position: Float32Array; lifecycle: Float32Array } {
  return {
    position: new Float32Array(3 * count),
    lifecycle: new Float32Array(FX_CORE_LIFECYCLE_STRIDE * count),
  };
}

describe("behavior attribute buffers", () => {
  it("spawn kernel writes a float attribute buffer alongside the core buffers", () => {
    const store = new FXBehaviorNodeStoreAttribute("seed", FLOAT, FXBehaviorPhase.SPAWN);
    const graph = graphOf(
      {
        life: reg.create("constant", { value: 4, phase: "spawn" }),
        seedVal: reg.create("constant", { value: 0.7, phase: "spawn" }),
        store,
      },
      [
        {
          from: { nodeId: "seedVal", socketKey: "out" },
          to: { nodeId: "store", socketKey: "value" },
        },
      ],
      [
        { slot: "lifetime", from: { nodeId: "life", socketKey: "out" } },
        { slot: attributeSlot("seed"), from: { nodeId: "store", socketKey: "value" } },
      ],
    );

    const targets = buildParticleBehaviorTargets([{ name: "seed", type: FLOAT }]);
    const compiled = compileBehavior(graph, targets);
    const spawn = buildParticleSpawnKernel(compiled);

    const buffers = { ...coreBuffers(2), seed: new Float32Array(2) };
    spawn(buffers, 0, 2, compiled.spawn.bindings);

    expect(buffers.lifecycle[0 * FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME]).toBe(4);
    expect(buffers.lifecycle[FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME]).toBe(4);
    expect(buffers.seed[0]).toBeCloseTo(0.7, 6);
    expect(buffers.seed[1]).toBeCloseTo(0.7, 6);
  });

  it("spawn kernel writes a vec3 attribute buffer", () => {
    const store = new FXBehaviorNodeStoreAttribute("tint", VEC3, FXBehaviorPhase.SPAWN);
    const graph = graphOf(
      {
        tintVal: reg.create("constant", { type: "vec3", value: [0.1, 0.2, 0.3], phase: "spawn" }),
        store,
      },
      [
        {
          from: { nodeId: "tintVal", socketKey: "out" },
          to: { nodeId: "store", socketKey: "value" },
        },
      ],
      [{ slot: attributeSlot("tint"), from: { nodeId: "store", socketKey: "value" } }],
    );

    const targets = buildParticleBehaviorTargets([{ name: "tint", type: VEC3 }]);
    const compiled = compileBehavior(graph, targets);
    const spawn = buildParticleSpawnKernel(compiled);

    const buffers = { ...coreBuffers(1), tint: new Float32Array(3) };
    spawn(buffers, 0, 1, compiled.spawn.bindings);

    [0.1, 0.2, 0.3].forEach((expected, i) => {
      expect(buffers.tint[i]).toBeCloseTo(expected, 6);
    });
  });

  it("writing an attribute on the UPDATE phase is legal", () => {
    const store = new FXBehaviorNodeStoreAttribute("energy", FLOAT, FXBehaviorPhase.UPDATE);
    const graph = graphOf(
      { e: reg.create("constant", { value: 0.5, phase: "update" }), store },
      [{ from: { nodeId: "e", socketKey: "out" }, to: { nodeId: "store", socketKey: "value" } }],
      [{ slot: attributeSlot("energy"), from: { nodeId: "store", socketKey: "value" } }],
    );

    const targets = buildParticleBehaviorTargets([{ name: "energy", type: FLOAT }]);
    const compiled = compileBehavior(graph, targets);
    const update = buildParticleUpdateKernel(compiled);

    const buffers = { ...coreBuffers(1), energy: new Float32Array(1) };
    update(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers.energy[0]).toBe(0.5);
  });
});

describe("buildParticleBehaviorTargets naming + layout", () => {
  it("names the empty target set plainly and salts with a canonical attribute suffix", () => {
    expect(buildParticleBehaviorTargets([]).spawn.name).toBe("particle-behavior-spawn");

    const attrs: FXAttributeRequest[] = [
      { name: "tint", type: VEC3 },
      { name: "seed", type: FLOAT },
    ];
    const targets = buildParticleBehaviorTargets(attrs);
    // Sorted by name -> order-independent salt.
    expect(targets.spawn.name).toBe("particle-behavior-spawn+seed:float+tint:vec3");
    expect(targets.update.name).toBe("particle-behavior-update+seed:float+tint:vec3");
  });

  it("exposes the core buffers, an attr buffer, an ATTR input and an attr slot in both phases", () => {
    const targets = buildParticleBehaviorTargets([{ name: "tint", type: VEC3 }]);
    for (const phase of [targets.spawn, targets.update]) {
      expect(phase.buffers).toEqual([
        { name: "position", stride: 3 },
        { name: "lifecycle", stride: 3 },
        { name: "tint", stride: 3 },
      ]);
      expect(phase.inputs.some((i) => i.name === "ATTR_tint" && i.buffer === "tint")).toBe(true);
      expect(
        phase.outputs.some((o) => o.slot === attributeSlot("tint") && o.buffer === "tint"),
      ).toBe(true);
    }
  });
});

/** The per-attribute buffers a compiled kernel declares (core position/lifecycle excluded). */
function attributeBuffersOf(compiled: FXCompiledKernel): readonly FXKernelBufferLayout[] {
  return compiled.update.buffers.filter(
    (buffer) => buffer.name !== FX_CORE_POSITION && buffer.name !== FX_CORE_LIFECYCLE,
  );
}

const seedStoreGraph = (): FXGraph<FXBehaviorNode> =>
  graphOf(
    {
      life: reg.create("constant", { value: 3, phase: "spawn" }),
      seedVal: reg.create("constant", { value: 0.5, phase: "spawn" }),
      store: new FXBehaviorNodeStoreAttribute("seed", FLOAT, FXBehaviorPhase.SPAWN),
    },
    [
      {
        from: { nodeId: "seedVal", socketKey: "out" },
        to: { nodeId: "store", socketKey: "value" },
      },
    ],
    [
      { slot: "lifetime", from: { nodeId: "life", socketKey: "out" } },
      { slot: attributeSlot("seed"), from: { nodeId: "store", socketKey: "value" } },
    ],
  );

const coreOnlyGraph = (): FXGraph<FXBehaviorNode> =>
  graphOf(
    { life: reg.create("constant", { value: 3, phase: "spawn" }) },
    [],
    [{ slot: "lifetime", from: { nodeId: "life", socketKey: "out" } }],
  );

describe("compiled kernel exposes its attribute buffer set", () => {
  it("derives the attribute buffers + written set from a store-attribute graph", () => {
    const compiled = compileBehavior(
      seedStoreGraph(),
      buildParticleBehaviorTargets([{ name: "seed", type: FLOAT }]),
    );
    expect(attributeBuffersOf(compiled)).toEqual([{ name: "seed", stride: 1 }]);
    expect(compiled.spawn?.writtenBuffers).toContain("seed");
  });

  it("has no attribute buffers for a core-only graph", () => {
    const compiled = compileBehavior(coreOnlyGraph(), buildParticleBehaviorTargets([]));
    expect(attributeBuffersOf(compiled)).toEqual([]);
  });

  it("grows its attribute set (and changes the recompile hash) when a store-attribute is added", () => {
    const core = compileBehavior(coreOnlyGraph(), buildParticleBehaviorTargets([]));
    const withAttr = compileBehavior(
      seedStoreGraph(),
      buildParticleBehaviorTargets([{ name: "seed", type: FLOAT }]),
    );

    expect(attributeBuffersOf(core)).toEqual([]);
    expect(attributeBuffersOf(withAttr)).toEqual([{ name: "seed", stride: 1 }]);
    // Adding the attribute reshapes the target -> different structural hash, so the live gate
    // recompiles (not rebinds). The hash is the gate's recompile-vs-rebind decision input.
    expect(withAttr.hash).not.toBe(core.hash);
  });
});
