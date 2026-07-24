import { describe, expect, it } from "vitest";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { FXBehaviorNodeCustomAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeCustomAttribute";
import { FXBehaviorNodeCustomAttributeSplit } from "../../src/engine/behavior/nodes/FXBehaviorNodeCustomAttributeSplit";
import { FXBehaviorNodeBuiltinAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeBuiltinAttribute";
import { compileBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import {
  attributeSlot,
  buildParticleBehaviorTargets,
} from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXBehaviorNodeStoreAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeStoreAttribute";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXGraphNode } from "../../src/engine/core/FXGraphNode";
import type {
  FXNodeCategory,
  FXNodeMeta,
  FXSocketMeta,
} from "../../src/engine/core/nodes/FXSocketSpec";
import type { FXSocketDescriptor } from "../../src/engine/core/socket/FXSocket";
import type { FXSocketType } from "../../src/engine/core/socket/FXValueType";
import { FX_VALUE_TYPES, isGenericType } from "../../src/engine/core/socket/FXValueType";
import { FX_MANUAL_NODE_METAS } from "../../src/engine/nodes-std/manualNodeMetas";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXRenderNodeCustomAttribute } from "../../src/engine/render/nodes/FXRenderNodeCustomAttribute";
import { FXRenderNodeCustomAttributeSplit } from "../../src/engine/render/nodes/FXRenderNodeCustomAttributeSplit";
import { FXRenderNodeBuiltinAttribute } from "../../src/engine/render/nodes/FXRenderNodeBuiltinAttribute";
import { FXRenderNodeTimelineValue } from "../../src/engine/render/nodes/FXRenderNodeTimelineValue";
import { FXRenderNodeTexture } from "../../src/engine/render/nodes/FXRenderNodeTexture";
import { FXBehaviorNodeTimelineValue } from "../../src/engine/behavior/nodes/FXBehaviorNodeTimelineValue";
import {
  buildParticleTarget,
  FX_PARTICLE_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import { behaviorRegistry } from "../helpers/stdRegistry";

const VEC4 = FX_VALUE_TYPES.vec4;

const CATEGORIES: readonly FXNodeCategory[] = [
  "source",
  "math",
  "color",
  "uv",
  "mask",
  "normal",
  "force",
  "spawn",
  "over-life",
  "attribute",
];

function edge(from: string, fromKey: string, to: string, toKey: string): FXConnection {
  return { from: { nodeId: from, socketKey: fromKey }, to: { nodeId: to, socketKey: toKey } };
}
function bind(slot: string, nodeId: string, socketKey: string): FXOutputBinding {
  return { slot, from: { nodeId, socketKey } };
}

/** Wraps a node's `build` to record every `readTargetInput`, then runs `compile`. */
function recordReads(node: FXGraphNode, compile: () => void): string[] {
  const target = node as unknown as { build: (ctx: object) => void };
  const actual: string[] = [];
  const original = target.build.bind(target);
  target.build = (ctx: object): void => {
    const proxy = new Proxy(ctx, {
      get(here, prop, receiver): unknown {
        if (prop === "readTargetInput") {
          return (name: string): unknown => {
            actual.push(name);
            return (Reflect.get(here, prop, receiver) as (n: string) => unknown).call(here, name);
          };
        }
        const value = Reflect.get(here, prop, receiver);
        return typeof value === "function" ? value.bind(here) : value;
      },
    });
    original(proxy);
  };
  compile();
  return actual;
}

/** A manual node under test: how to build it, compile it, and its declared class reads. */
interface ManualCase {
  readonly type: string;
  readonly node: FXGraphNode;
  readonly compile: () => void;
  readonly declaredReads: readonly string[];
}

function renderCase(
  type: string,
  node: FXRenderNode,
  extra: readonly FXRenderNode[],
  connections: readonly FXConnection[],
  outputBindings: readonly FXOutputBinding[],
  target = FX_PARTICLE_TARGET,
): ManualCase {
  const graph = new FXGraph<FXRenderNode>();
  const nodes = new Map<string, FXRenderNode>([["n", node]]);
  extra.forEach((e, i) => nodes.set(`x${i.toString()}`, e));
  graph.ingest({ nodes, connections, outputBindings });
  return {
    type,
    node,
    declaredReads: node.targetReads ?? [],
    compile: () => {
      new FXCompilerBaseline().compile(graph, target);
    },
  };
}

function manualCases(): ManualCase[] {
  // custom-attribute: reads the (name-dependent) p_fx_tint varying.
  const readAttr = renderCase(
    "custom-attribute",
    new FXRenderNodeCustomAttribute("tint", VEC4),
    [],
    [],
    [bind("albedo", "n", "value")],
    buildParticleTarget([{ name: "tint", type: VEC4 }]),
  );
  // builtin-attribute: reads all four PARTICLE_* target inputs unconditionally, regardless
  // of which output actually feeds a binding.
  const readBuiltin = renderCase(
    "builtin-attribute",
    new FXRenderNodeBuiltinAttribute(),
    [],
    [],
    [bind("albedo", "n", "age")],
  );

  return [readAttr, readBuiltin];
}

const CASES = manualCases();
// Keyed by domain+type: `custom-attribute` exists in both the render (GPU) and behavior
// (CPU) domains as distinct nodes that share a type string.
const metaKey = (m: { domain: string; type: string }): string => `${m.domain}:${m.type}`;
const METAS_BY_KEY = new Map<string, FXNodeMeta>(FX_MANUAL_NODE_METAS.map((m) => [metaKey(m), m]));

/**
 * The hand-written (editor-owned) manual node classes - the ones carrying a `three`
 * resource, an `attributeRequest`, or a gradient, so they are not `defineNode`
 * descriptors. Each exposes a static `describe()`; a new such class added without a meta
 * trips the single-source contract below (M9). (Discovered by explicit import now that
 * the runtime `sparcoon` entry no longer re-exports the editor node classes.)
 */
const MANUAL_CLASSES: { describe(): FXNodeMeta }[] = [
  FXRenderNodeCustomAttribute,
  FXBehaviorNodeCustomAttribute,
  FXRenderNodeCustomAttributeSplit,
  FXBehaviorNodeCustomAttributeSplit,
  FXRenderNodeBuiltinAttribute,
  FXBehaviorNodeBuiltinAttribute,
  FXBehaviorNodeStoreAttribute,
  FXRenderNodeTimelineValue,
  FXBehaviorNodeTimelineValue,
  FXRenderNodeTexture,
];

describe("manual node palette metadata", () => {
  it("has a meta for exactly the exported manual node classes (single source)", () => {
    const classKeys = MANUAL_CLASSES.map((cls) => metaKey(cls.describe())).sort();
    const metaKeys = FX_MANUAL_NODE_METAS.map(metaKey).sort();
    expect(classKeys).toEqual(metaKeys);
    // Each class's static describe() returns exactly its FX_MANUAL_NODE_METAS entry.
    for (const cls of MANUAL_CLASSES) {
      const meta = cls.describe();
      expect(METAS_BY_KEY.get(metaKey(meta))).toBe(meta);
    }
  });

  it("describe() metadata is deeply frozen (a mutating consumer fails loudly)", () => {
    for (const meta of FX_MANUAL_NODE_METAS) {
      expect(Object.isFrozen(meta)).toBe(true);
      expect(Object.isFrozen(meta.params)).toBe(true);
      expect(Object.isFrozen(meta.inputs)).toBe(true);
    }
  });

  for (const meta of FX_MANUAL_NODE_METAS) {
    describe(meta.type, () => {
      it("is JSON-serializable with a known category", () => {
        expect(() => JSON.stringify(meta)).not.toThrow();
        expect(CATEGORIES).toContain(meta.category);
      });
    });
  }
});

describe("manual node anti-rot: actual reads are a subset of declared/described reads", () => {
  for (const testCase of CASES) {
    it(`${testCase.type} declares every target input its build() reads`, () => {
      const actual = recordReads(testCase.node, testCase.compile);
      // The harness must have actually run build() and hit the reads (not vacuous).
      if (testCase.declaredReads.length > 0) {
        expect(actual.length).toBeGreaterThan(0);
      }
      // Every actual read is in the class's declared targetReads.
      for (const name of actual) {
        expect(testCase.declaredReads).toContain(name);
      }
      // And the palette meta's reads cover the declared set (unless "dynamic"). All
      // CASES are render-domain manual nodes.
      const meta = METAS_BY_KEY.get(`render:${testCase.type}`);
      expect(meta).toBeDefined();
      if (meta !== undefined && meta.reads !== "dynamic") {
        for (const name of testCase.declaredReads) {
          expect(meta.reads).toContain(name);
        }
      }
    });
  }
});

describe("manual node meta matches the instantiated class's sockets (M9 anti-drift)", () => {
  const FLOAT = FX_VALUE_TYPES.float;
  // Class socket type -> the meta's string form (`"T"` for a generic socket, else the type name).
  const metaType = (type: FXSocketType): string => (isGenericType(type) ? "T" : type.glslTypeName);
  const classSockets = (sockets: readonly FXSocketDescriptor[]): { key: string; type: string }[] =>
    sockets
      .map((socket) => ({ key: socket.key, type: metaType(socket.type) }))
      .sort((a, b) => a.key.localeCompare(b.key));
  const metaSockets = (sockets: readonly FXSocketMeta[]): { key: string; type: string }[] =>
    sockets
      .map((socket) => ({ key: socket.key, type: socket.type }))
      .sort((a, b) => a.key.localeCompare(b.key));

  // Socket keys must match exactly (a class socket the meta omits, or vice versa, is drift). Types
  // too - except a generic meta socket (`"T"`) is realized to a concrete type per instance, so any
  // concrete instance type satisfies it; only a concrete meta type must match exactly.
  const compareSockets = (
    fromClass: { key: string; type: string }[],
    fromMeta: { key: string; type: string }[],
  ): void => {
    expect(fromClass.map((socket) => socket.key)).toEqual(fromMeta.map((socket) => socket.key));
    fromMeta.forEach((socket, index) => {
      if (socket.type !== "T") {
        expect(fromClass[index]?.type).toBe(socket.type);
      }
    });
  };

  // Each manual class instantiated with representative args, paired with its static meta.
  const instances: { meta: FXNodeMeta; node: FXGraphNode }[] = [
    {
      meta: FXRenderNodeCustomAttribute.describe(),
      node: new FXRenderNodeCustomAttribute("tint", VEC4),
    },
    {
      meta: FXBehaviorNodeCustomAttribute.describe(),
      node: new FXBehaviorNodeCustomAttribute("tint", VEC4),
    },
    {
      // VEC4 (widest type) so the instance's outputs cover all four declared x/y/z/w keys.
      meta: FXRenderNodeCustomAttributeSplit.describe(),
      node: new FXRenderNodeCustomAttributeSplit("tint", VEC4),
    },
    {
      meta: FXBehaviorNodeCustomAttributeSplit.describe(),
      node: new FXBehaviorNodeCustomAttributeSplit("tint", VEC4),
    },
    {
      meta: FXRenderNodeBuiltinAttribute.describe(),
      node: new FXRenderNodeBuiltinAttribute(),
    },
    {
      meta: FXBehaviorNodeBuiltinAttribute.describe(),
      node: new FXBehaviorNodeBuiltinAttribute(),
    },
    {
      meta: FXBehaviorNodeStoreAttribute.describe(),
      node: new FXBehaviorNodeStoreAttribute("tint", VEC4, FXBehaviorPhase.SPAWN),
    },
    {
      meta: FXRenderNodeTimelineValue.describe(),
      node: new FXRenderNodeTimelineValue("power", FLOAT, 1),
    },
    {
      meta: FXBehaviorNodeTimelineValue.describe(),
      node: new FXBehaviorNodeTimelineValue("power", FLOAT, 1),
    },
    { meta: FXRenderNodeTexture.describe(), node: new FXRenderNodeTexture("tex") },
  ];

  for (const { meta, node } of instances) {
    it(`${meta.domain}:${meta.type} inputs/outputs equal its palette meta`, () => {
      compareSockets(classSockets(node.inputs), metaSockets(meta.inputs));
      compareSockets(classSockets(node.outputs), metaSockets(meta.outputs));
    });
  }
});

describe("store-attribute anti-rot (behavior)", () => {
  it("reads nothing and its meta agrees", () => {
    const store = new FXBehaviorNodeStoreAttribute("tint", VEC4, FXBehaviorPhase.SPAWN);
    const reg = behaviorRegistry();
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map<string, FXBehaviorNode>([
        ["v", reg.create("constant", { type: "vec4", value: [1, 0, 0, 1], phase: "spawn" })],
        ["s", store],
      ]),
      connections: [edge("v", "out", "s", "value")],
      outputBindings: [bind(attributeSlot("tint"), "s", "value")],
    });
    const actual = recordReads(store, () => {
      compileBehavior(graph, buildParticleBehaviorTargets([{ name: "tint", type: VEC4 }]));
    });
    expect(actual).toEqual([]);
    expect((store.targetReads ?? []).length).toBe(0);
    expect(METAS_BY_KEY.get("behavior:store-attribute")?.reads).toEqual([]);
  });
});
