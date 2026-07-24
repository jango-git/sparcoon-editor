import { describe, expect, it } from "vitest";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileParticleBehavior,
  validateParticleBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXCompiledKernel } from "../../src/engine/behavior/FXCompiledKernel";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FX_LIFETIME, FX_POSITION_X, FX_POSITION_Y, FX_POSITION_Z } from "sparcoon";
import { behaviorRegistry } from "../helpers/stdRegistry";
import { attributeSlot, readAttrComponents, storeAttr } from "../helpers/attr";

const VEC3 = FX_VALUE_TYPES.vec3;
const FLOAT = FX_VALUE_TYPES.float;

const reg = behaviorRegistry();

function graphOf(
  nodes: Record<string, FXBehaviorNode>,
  connections: readonly FXConnection[],
  outputBindings: readonly FXOutputBinding[],
): FXGraph<FXBehaviorNode> {
  const graph = new FXGraph<FXBehaviorNode>();
  graph.ingest({ nodes: new Map(Object.entries(nodes)), connections, outputBindings });
  return graph;
}

function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}
function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

function buffersFor(compiled: FXCompiledKernel, count: number): Record<string, Float32Array> {
  const buffers: Record<string, Float32Array> = {};
  for (const buffer of compiled.update.buffers) {
    buffers[buffer.name] = new Float32Array(buffer.stride * count);
  }
  return buffers;
}

describe("custom-attribute-split behavior node", () => {
  it("declares its attribute request and cache key like custom-attribute", () => {
    const node = readAttrComponents("velocity", VEC3);
    expect(node.attributeRequest).toEqual({ name: "velocity", type: VEC3 });
    expect(node.phaseFlexible).toBe(true);
    expect(node.cacheKey()).toBe("velocity:vec3");
  });

  it("always declares all four x/y/z/w float outputs, regardless of the source width", () => {
    const node = readAttrComponents("scale", FLOAT);
    expect(node.outputs.map((socket) => socket.key)).toEqual(["x", "y", "z", "w"]);
    expect(node.outputs.every((socket) => socket.type === FLOAT)).toBe(true);
  });

  it("keeps name/type structural, tolerates a re-applied phase", () => {
    const node = readAttrComponents("velocity", VEC3);
    expect(() => node.applyParams({ name: "velocity", type: "vec3" })).not.toThrow();
    expect(() => node.applyParams({ phase: "spawn" })).not.toThrow();
    expect(() => node.applyParams({ phase: "update" })).not.toThrow();
    expect(() => node.applyParams({ phase: "Spawn" })).toThrow(/"phase" must be/);
    expect(() => node.applyParams({ type: "vec4" })).toThrow(/structural param "type"/);
    expect(() => node.applyParams({ name: "other" })).toThrow(/structural param "name"/);
  });

  it("splits a stored vec3 attribute into x/y/z, each independently readable", () => {
    // Spawn writes velocity = (1, 2, 3); update reads it back split, feeding each component into
    // its own scalar position sub-slot (positionX/Y/Z - independent offsets, no overlap).
    const graph = graphOf(
      {
        vx: reg.create("constant", { value: 1, phase: "spawn" }),
        vy: reg.create("constant", { value: 2, phase: "spawn" }),
        vz: reg.create("constant", { value: 3, phase: "spawn" }),
        combine: reg.create("combine", { type: "vec3" }),
        sv: storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN),
        rv: readAttrComponents("velocity", VEC3),
      },
      [
        edge("vx", "out", "combine", "x"),
        edge("vy", "out", "combine", "y"),
        edge("vz", "out", "combine", "z"),
        edge("combine", "out", "sv", "value"),
      ],
      [
        bind(attributeSlot("velocity"), "sv", "value"),
        bind("positionX", "rv", "x"),
        bind("positionY", "rv", "y"),
        bind("positionZ", "rv", "z"),
      ],
    );

    const compiled = compileParticleBehavior(graph);
    const buffers = buffersFor(compiled, 1);
    buildParticleSpawnKernel(compiled)(buffers, 0, 1, compiled.spawn.bindings);
    expect(buffers.velocity[FX_POSITION_X]).toBe(1);
    expect(buffers.velocity[FX_POSITION_Y]).toBe(2);
    expect(buffers.velocity[FX_POSITION_Z]).toBe(3);

    buildParticleUpdateKernel(compiled)(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers.position[FX_POSITION_X]).toBe(1);
    expect(buffers.position[FX_POSITION_Y]).toBe(2);
    expect(buffers.position[FX_POSITION_Z]).toBe(3);
  });

  it("reads a float attribute with only x meaningfully wired (no swizzle-on-scalar crash)", () => {
    // "seed" is read but never stored in this graph - its buffer is auto-allocated from `rd`'s
    // own attribute request and poked directly, isolating the read (no write-ordering to race).
    const graph = graphOf(
      { rd: readAttrComponents("seed", FLOAT, FXBehaviorPhase.SPAWN) },
      [],
      [bind("lifetime", "rd", "x")],
    );
    expect(validateParticleBehavior(graph).ok).toBe(true);
    const compiled = compileParticleBehavior(graph);
    const buffers = buffersFor(compiled, 1);
    buffers["seed"][0] = 0.7;
    buildParticleSpawnKernel(compiled)(buffers, 0, 1, compiled.spawn.bindings);
    expect(buffers.lifecycle[FX_LIFETIME]).toBeCloseTo(0.7, 6);
  });

  it("reads a user attribute in the spawn phase when its consumer is spawn-only (editor path)", () => {
    // Mirrors custom-attribute's own inference test: no explicit phase on the reader, but a
    // spawn-only consumer pulls it into spawn instead of erroring cross-phase-dependency.
    const graph = graphOf(
      {
        rd: readAttrComponents("src", FLOAT), // default UPDATE nominal, phase-flexible
        st: storeAttr("dst", FLOAT, FXBehaviorPhase.SPAWN),
      },
      [edge("rd", "x", "st", "value")],
      [bind(attributeSlot("dst"), "st", "value")],
    );
    expect(validateParticleBehavior(graph).ok).toBe(true);
    const compiled = compileParticleBehavior(graph);
    const buffers = buffersFor(compiled, 1);
    buffers["src"][0] = 42;
    buildParticleSpawnKernel(compiled)(buffers, 0, 1, compiled.spawn.bindings);
    expect(buffers["dst"][0]).toBe(42);
  });
});
