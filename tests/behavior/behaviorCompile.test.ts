import { describe, expect, it } from "vitest";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileParticleBehavior,
  previewParticleBehaviorHash,
  validateParticleBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import {
  FX_CORE_LIFECYCLE_STRIDE,
  FX_LIFETIME,
  FX_POSITION_X,
  FX_POSITION_Y,
  FX_POSITION_Z,
} from "sparcoon";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { behaviorRegistry } from "../helpers/stdRegistry";
import {
  attributeSlot,
  readAttr,
  readAttrComponents,
  readBuiltinAttr,
  storeAttr,
} from "../helpers/attr";
import { bind, buffersFor, edge, graphOf } from "../helpers/graphBuild";

const reg = behaviorRegistry();
const VEC3 = FX_VALUE_TYPES.vec3;

describe("compileParticleBehavior - kernels produce correct numbers", () => {
  it("spawn kernel writes lifetime (core lifecycle) and position (core position)", () => {
    const graph = graphOf(
      {
        life: reg.create("lifetime", { min: 2, max: 2 }),
        point: reg.create("spawn-box", { size: [0, 0, 0], center: [1, 2, 3] }),
      },
      [],
      [bind("lifetime", "life", "value"), bind("position", "point", "position")],
    );
    const compiled = compileParticleBehavior(graph);
    const spawn = buildParticleSpawnKernel(compiled);

    const buffers = buffersFor(compiled, 2);
    spawn(buffers, 0, 2, compiled.spawn!.bindings);

    for (let i = 0; i < 2; i++) {
      expect(buffers.lifecycle[i * FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME]).toBe(2);
      expect(buffers.position[i * 3 + FX_POSITION_X]).toBe(1);
      expect(buffers.position[i * 3 + FX_POSITION_Y]).toBe(2);
      expect(buffers.position[i * 3 + FX_POSITION_Z]).toBe(3);
    }
  });
});

describe("validateParticleBehavior - phase and overlap rules", () => {
  it("rejects a cross-phase dependency", () => {
    const graph = graphOf(
      {
        // Two genuinely fixed-phase nodes: gravity is update-only (it reads `dt`), and a
        // store-attribute pinned to spawn is spawn-only. An update value feeding a spawn
        // input is illegal across phases (they run at different times). Value-only spawn
        // nodes like initial-velocity are not pinned - their placement is inferred.
        grav: reg.create("gravity", { acceleration: [0, -10, 0] }),
        store: storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN),
      },
      [edge("grav", "velocity", "store", "value")],
      [bind(attributeSlot("velocity"), "store", "value")],
    );

    const result = validateParticleBehavior(graph);

    expect(result.errors.some((e) => e.code === "cross-phase-dependency")).toBe(true);
  });

  // What the editor produces: a reader with no `phase` param (nominal update) feeding a spawn
  // store. The compiler infers the reader into the spawn phase instead of erroring
  // `cross-phase-dependency`; `store-attribute` stays fixed (its phase is authored by the sink).
  it.each([
    { reader: "custom-attribute", node: () => readAttr("src", FX_VALUE_TYPES.float), out: "value" },
    {
      reader: "custom-attribute-split",
      node: () => readAttrComponents("src", FX_VALUE_TYPES.float),
      out: "x",
    },
  ])("infers a phase-less $reader into spawn when its consumer is spawn-only", ({ node, out }) => {
    const graph = graphOf(
      { rd: node(), st: storeAttr("dst", FX_VALUE_TYPES.float, FXBehaviorPhase.SPAWN) },
      [edge("rd", out, "st", "value")],
      [bind(attributeSlot("dst"), "st", "value")],
    );
    expect(validateParticleBehavior(graph).ok).toBe(true);

    // And it actually runs there: the spawn kernel copies src -> dst per particle.
    const compiled = compileParticleBehavior(graph);
    const buffers = buffersFor(compiled, 1);
    buffers["src"][0] = 42;
    buildParticleSpawnKernel(compiled)(buffers, 0, 1, compiled.spawn!.bindings);
    expect(buffers["dst"][0]).toBe(42);
  });

  it("flags two update slots that write the same core offset", () => {
    // `position` (vec3) and `positionX` (scalar) both write position offset 0.
    const graph = graphOf(
      {
        g: reg.create("gravity", {}),
        c: reg.create("constant", { value: 1, phase: "update" }),
      },
      [],
      [bind("position", "g", "velocity"), bind("positionX", "c", "out")],
    );

    const result = validateParticleBehavior(graph);

    expect(result.errors.some((e) => e.code === "overlapping-output-slots")).toBe(true);
  });

  it("allows the same slot written in different phases", () => {
    // `position` is seeded at spawn (spawn-box) and integrated at update
    // (integrate-motion) - the canonical dual-phase slot. Per-phase overlap checks must
    // not flag it, and inference places each fixed-phase producer in its own phase.
    const graph = graphOf(
      {
        sp: reg.create("spawn-box", { size: [0, 0, 0], center: [0, 0, 0] }),
        iv: reg.create("initial-velocity", { direction: [0, 1, 0], speed: [1, 1] }),
        svs: storeAttr("velocity", VEC3, FXBehaviorPhase.SPAWN),
        rv: readAttr("velocity", VEC3),
        im: reg.create("integrate-motion", {}),
      },
      [edge("iv", "velocity", "svs", "value"), edge("rv", "value", "im", "velocity")],
      [
        bind("position", "sp", "position"),
        bind(attributeSlot("velocity"), "svs", "value"),
        bind("position", "im", "position"),
      ],
    );

    const result = validateParticleBehavior(graph);

    expect(result.ok).toBe(true);
  });
});

describe("phase-scoped output bindings place flexible nodes", () => {
  const boundPosition = (phase: "spawn" | "update" | undefined): FXGraph<FXBehaviorNode> =>
    graphOf(
      { box: reg.create("spawn-box", { size: [0, 0, 0], center: [5, 6, 7] }) },
      [],
      [
        {
          slot: "position",
          from: { nodeId: "box", socketKey: "position" },
          ...(phase !== undefined && { phase }),
        },
      ],
    );

  it("runs a flexible spawn node in update when its binding names the update phase", () => {
    const compiled = compileParticleBehavior(boundPosition("update"));
    const buffers = buffersFor(compiled, 1);

    buildParticleSpawnKernel(compiled)(buffers, 0, 1, compiled.spawn!.bindings);
    // Bound into update, not spawn: the spawn kernel leaves position at its zero default.
    expect(buffers.position[FX_POSITION_X]).toBe(0);

    buildParticleUpdateKernel(compiled)(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers.position[FX_POSITION_X]).toBe(5);
  });

  it("falls back to the node's declared phase (spawn) when the binding names no phase", () => {
    const compiled = compileParticleBehavior(boundPosition(undefined));
    const buffers = buffersFor(compiled, 1);

    buildParticleSpawnKernel(compiled)(buffers, 0, 1, compiled.spawn!.bindings);
    // No phase signal: spawn-box keeps its declared `spawn` default, so it seeds at birth.
    expect(buffers.position[FX_POSITION_X]).toBe(5);
  });

  it("folds the binding phase into the structural hash (a phase move recompiles)", () => {
    expect(previewParticleBehaviorHash(boundPosition("spawn"))).not.toBe(
      previewParticleBehaviorHash(boundPosition("update")),
    );
  });
});

describe("builtin-attribute reads builtins; custom-attribute reads user attributes", () => {
  it("a builtin read (position) allocates no attribute buffer, a user read does", () => {
    const builtin = graphOf(
      { rp: readBuiltinAttr() },
      [],
      [{ slot: "position", from: { nodeId: "rp", socketKey: "position" }, phase: "update" }],
    );
    // A builtin reads host state, so it carries no attributeRequest and adds no buffer.
    expect(builtin.getNode("rp")?.attributeRequest).toBeUndefined();
    const compiledBuiltin = compileParticleBehavior(builtin);
    expect(compiledBuiltin.update.buffers.map((b) => b.name).sort()).toEqual([
      "lifecycle",
      "position",
    ]);

    // A user attribute read still reserves its buffer.
    const user = readAttr("velocity", VEC3);
    expect(user.attributeRequest).toEqual({ name: "velocity", type: VEC3 });
  });
});

describe("numeric coercion into output slots", () => {
  it("splats a scalar producer across the vec3 position slot", () => {
    // A float `lifetime` value bound to the vec3 `position` slot splats into every
    // component (float -> vecN sugar), rather than being rejected as a type mismatch.
    const graph = graphOf(
      { life: reg.create("lifetime", { min: 5, max: 5 }) },
      [],
      [bind("lifetime", "life", "value"), bind("position", "life", "value")],
    );
    const compiled = compileParticleBehavior(graph);
    const spawn = buildParticleSpawnKernel(compiled);

    const buffers = buffersFor(compiled, 1);
    spawn(buffers, 0, 1, compiled.spawn!.bindings);

    expect(buffers.position[FX_POSITION_X]).toBe(5);
    expect(buffers.position[FX_POSITION_Y]).toBe(5);
    expect(buffers.position[FX_POSITION_Z]).toBe(5);
  });

  it("narrows a vec3 producer bound to the scalar lifetime slot to its first component", () => {
    const graph = graphOf(
      { point: reg.create("spawn-box", { size: [0, 0, 0], center: [7, 2, 3] }) },
      [],
      [bind("lifetime", "point", "position"), bind("position", "point", "position")],
    );
    const compiled = compileParticleBehavior(graph);
    const spawn = buildParticleSpawnKernel(compiled);

    const buffers = buffersFor(compiled, 1);
    spawn(buffers, 0, 1, compiled.spawn!.bindings);

    // The vec3 (7, 2, 3) narrows to its first component for the scalar slot.
    expect(buffers.lifecycle[FX_LIFETIME]).toBe(7);
  });
});
