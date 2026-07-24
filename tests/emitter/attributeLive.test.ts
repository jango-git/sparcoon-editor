import { describe, expect, it } from "vitest";
import { FXEmitter } from "sparcoon/editor";
import { FXLiveGraph } from "../../src/engine/core/live/FXLiveGraph";
import { FXGraphReconciler } from "../../src/engine/core/live/FXGraphReconciler";
import { FXBehaviorLiveBackend } from "../../src/engine/behavior/live/FXBehaviorLiveBackend";
import { FXRenderLiveBackend } from "../../src/engine/render/live/FXRenderLiveBackend";
import { FXBehaviorNodeStoreAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeStoreAttribute";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import {
  attributeSlot,
  buildParticleBehaviorTargets,
} from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXRenderNodeCustomAttribute } from "../../src/engine/render/nodes/FXRenderNodeCustomAttribute";
import { buildParticleTarget } from "../../src/engine/render/target/FXParticleRenderTarget";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import type { FXGraphSnapshotData } from "../../src/engine/core/live/FXSnapshotData";
import { resolveValueType } from "../../src/engine/core/socket/FXValueType";
import type { FXGLSLTypeName } from "../../src/engine/core/socket/FXValueType";
import {
  registerStandardBehaviorNodes,
  registerStandardRenderNodes,
} from "../../src/engine/nodes-std/index";
import { behaviorArtifact, unlitArtifact } from "../helpers/artifacts";

function behaviorReg(): FXNodeRegistry<FXBehaviorNode> {
  const r = new FXNodeRegistry<FXBehaviorNode>();
  registerStandardBehaviorNodes(r);
  r.register(
    "store-attribute",
    (p) =>
      new FXBehaviorNodeStoreAttribute(
        p?.["name"] as string,
        resolveValueType(p?.["type"] as FXGLSLTypeName),
        FXBehaviorPhase.SPAWN,
      ),
  );
  return r;
}

function renderReg(): FXNodeRegistry<FXRenderNode> {
  const r = new FXNodeRegistry<FXRenderNode>();
  registerStandardRenderNodes(r);
  r.register(
    "custom-attribute",
    (p) =>
      new FXRenderNodeCustomAttribute(
        p?.["name"] as string,
        resolveValueType(p?.["type"] as FXGLSLTypeName),
        p?.["stage"] === "vertex" ? FXShaderStage.VERTEX : FXShaderStage.FRAGMENT,
      ),
  );
  return r;
}

// The live reconcile gate the deleted `FXGraphUnlitMaterial.live` / `FXSimulation.live`
// wrapped: an `FXLiveGraph` over a reconciler + the still-alive render/behavior backend.
// `apply()`/`destroy()` behave identically (same `{ status, errors }` gate result).
function renderLive(): FXLiveGraph<FXRenderNode> {
  return new FXLiveGraph<FXRenderNode>(
    new FXGraphReconciler(renderReg()),
    new FXRenderLiveBackend(
      "baseline",
      (attributes) => buildParticleTarget(attributes),
      () => {},
    ),
  );
}

function behaviorLive(): FXLiveGraph<FXBehaviorNode> {
  return new FXLiveGraph<FXBehaviorNode>(
    new FXGraphReconciler(behaviorReg()),
    new FXBehaviorLiveBackend(() => {}, buildParticleBehaviorTargets),
  );
}

const behaviorWithOffset: FXGraphSnapshotData = {
  version: 2,
  nodes: {
    life: { type: "constant", params: { value: 4, phase: "spawn" } },
    off: { type: "constant", params: { type: "vec3", value: [1, 2, 3], phase: "spawn" } },
    store: { type: "store-attribute", params: { name: "offset", type: "vec3" } },
  },
  connections: [
    { from: { nodeId: "off", socketKey: "out" }, to: { nodeId: "store", socketKey: "value" } },
  ],
  outputBindings: [
    { slot: "lifetime", from: { nodeId: "life", socketKey: "out" } },
    { slot: attributeSlot("offset"), from: { nodeId: "store", socketKey: "value" } },
  ],
};

// The manual custom-attribute/store-attribute nodes carry a *structural* param (name/type/stage). An
// editor re-typing one under a stable id must be rejected (as `structural-param-immutable`, or
// `bad-param-stage` for an illegal stage spelling) - a silent no-op under a green `rebound` would
// drift editor state from the runtime. This exercises the (editor-owned, still-present) live
// reconcile gate directly, not the emitter.
describe("structural params of manual nodes under a stable id (P13.5 / audit-3 R5)", () => {
  const readSnapshot = (type: string, stage = "vertex"): FXGraphSnapshotData => ({
    version: 2,
    nodes: {
      c: { type: "constant", params: { type: "color", value: [1, 1, 1, 1] } },
      off: { type: "custom-attribute", params: { name: "offset", type, stage } },
      compose: { type: "compose-transform", params: {} },
    },
    connections: [
      {
        from: { nodeId: "off", socketKey: "value" },
        to: { nodeId: "compose", socketKey: "position" },
      },
    ],
    outputBindings: [
      { slot: "albedo", from: { nodeId: "c", socketKey: "out" } },
      { slot: "particleTransform", from: { nodeId: "compose", socketKey: "out" } },
    ],
  });

  it("rejects an in-place re-type of custom-attribute as structural-param-immutable with the node id", () => {
    const live = renderLive();
    expect(live.apply(readSnapshot("vec3")).status).toBe("recompiled");

    const result = live.apply(readSnapshot("vec4"));
    expect(result.status).toBe("invalid");
    expect(
      result.errors.some(
        (error) => error.code === "structural-param-immutable" && error.nodeId === "off",
      ),
    ).toBe(true);
    live.destroy();
  });

  it("rejects an invalid stage value as bad-param-stage, not silence", () => {
    const live = renderLive();
    expect(live.apply(readSnapshot("vec3")).status).toBe("recompiled");
    const result = live.apply(readSnapshot("vec3", "geometry"));
    expect(result.status).toBe("invalid");
    expect(
      result.errors.some((error) => error.code === "bad-param-stage" && error.nodeId === "off"),
    ).toBe(true);
    live.destroy();
  });

  it("rejects an in-place re-type of store-attribute as structural-param-immutable with the node id", () => {
    const live = behaviorLive();
    expect(live.apply(behaviorWithOffset).status).toBe("recompiled");

    const retyped: FXGraphSnapshotData = {
      ...behaviorWithOffset,
      nodes: {
        ...behaviorWithOffset.nodes,
        store: { type: "store-attribute", params: { name: "offset", type: "vec4" } },
      },
    };
    const result = live.apply(retyped);
    expect(result.status).toBe("invalid");
    expect(
      result.errors.some(
        (error) => error.code === "structural-param-immutable" && error.nodeId === "store",
      ),
    ).toBe(true);
    live.destroy();
  });
});

describe("cross-artifact attribute width conflict", () => {
  it("rejects an emitter whose behavior write and render read widths disagree", () => {
    // Behavior writes tint:vec3, the render artifact reads tint:vec4 - the emitter must
    // refuse to size one buffer two ways.
    expect(() =>
      FXEmitter.fromArtifacts(
        unlitArtifact({
          attributeReads: [{ name: "tint", components: 4 }],
          outputs: { albedo: "p_fx_tint" },
        }),
        behaviorArtifact({
          lifetime: 4,
          attributes: [{ name: "tint", components: 3, value: [1, 0, 0] }],
        }),
      ),
    ).toThrow(/conflicting widths/);
  });
});
