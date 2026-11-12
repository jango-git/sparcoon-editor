import { describe, expect, it } from "vitest";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import { compileParticleBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { attributeSlot } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import { FXBehaviorNodeBuiltinAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeBuiltinAttribute";
import { FXBehaviorNodeCustomAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeCustomAttribute";
import { FXBehaviorNodeCustomAttributeSplit } from "../../src/engine/behavior/nodes/FXBehaviorNodeCustomAttributeSplit";
import { FXBehaviorNodeStoreAttribute } from "../../src/engine/behavior/nodes/FXBehaviorNodeStoreAttribute";
import { FXBehaviorNodeTimelineValue } from "../../src/engine/behavior/nodes/FXBehaviorNodeTimelineValue";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
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
import { FXRenderNodeBuiltinAttribute } from "../../src/engine/render/nodes/FXRenderNodeBuiltinAttribute";
import { FXRenderNodeCustomAttribute } from "../../src/engine/render/nodes/FXRenderNodeCustomAttribute";
import { FXRenderNodeCustomAttributeSplit } from "../../src/engine/render/nodes/FXRenderNodeCustomAttributeSplit";
import { FXRenderNodeTexture } from "../../src/engine/render/nodes/FXRenderNodeTexture";
import { FXRenderNodeTimelineValue } from "../../src/engine/render/nodes/FXRenderNodeTimelineValue";
import {
  buildParticleTarget,
  FX_PARTICLE_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";

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

/** A manual node under test: how to compile it, and its declared class reads. */
interface ManualCase {
  readonly domain: "render" | "behavior";
  readonly type: string;
  readonly node: FXGraphNode;
  readonly compile: () => void;
}

const renderReg = renderRegistry();
const behaviorReg = behaviorRegistry();

/** `node` as `n` beside a white albedo `c`, compiled on the render baseline compiler. */
function renderCase(
  node: FXRenderNode,
  outputBindings: readonly FXOutputBinding[],
  target = FX_PARTICLE_TARGET,
): ManualCase {
  const white = renderReg.create("constant", { type: "color", value: [1, 1, 1, 1] });
  const graph = graphOf({ n: node, c: white }, [], [bind("albedo", "c", "out"), ...outputBindings]);
  return {
    domain: "render",
    type: node.type,
    node,
    compile: () => {
      new FXCompilerBaseline().compile(graph, target);
    },
  };
}

/** `node` as `n` (plus `extra` nodes), compiled on the JS behavior backend. */
function behaviorCase(
  node: FXBehaviorNode,
  outputBindings: readonly FXOutputBinding[],
  extra: Readonly<Record<string, FXBehaviorNode>> = {},
  connections: readonly FXConnection[] = [],
): ManualCase {
  const graph = graphOf({ n: node, ...extra }, connections, outputBindings);
  return {
    domain: "behavior",
    type: node.type,
    node,
    compile: () => {
      compileParticleBehavior(graph);
    },
  };
}

/** One compiling graph per manual node class (see {@link MANUAL_CLASSES}). */
function manualCases(): ManualCase[] {
  const VEC3 = FX_VALUE_TYPES.vec3;
  const FLOAT = FX_VALUE_TYPES.float;
  return [
    // custom-attribute: reads the (name-dependent) p_fx_tint varying.
    renderCase(
      new FXRenderNodeCustomAttribute("tint", VEC4),
      [bind("intensity", "n", "value")],
      buildParticleTarget([{ name: "tint", type: VEC4 }]),
    ),
    renderCase(
      new FXRenderNodeCustomAttributeSplit("tint", VEC4),
      [bind("alphaThreshold", "n", "x")],
      buildParticleTarget([{ name: "tint", type: VEC4 }]),
    ),
    // builtin-attribute: reads all four PARTICLE_* target inputs unconditionally, regardless
    // of which output actually feeds a binding.
    renderCase(new FXRenderNodeBuiltinAttribute(), [bind("alphaThreshold", "n", "age")]),
    renderCase(new FXRenderNodeTimelineValue("power", FLOAT, 1), [
      bind("alphaThreshold", "n", "out"),
    ]),
    // texture: samples at its uv default, the particle UV builtin.
    renderCase(new FXRenderNodeTexture("tex"), [bind("intensity", "n", "color")]),
    behaviorCase(new FXBehaviorNodeCustomAttribute("velocity", VEC3), [
      bind("position", "n", "value"),
    ]),
    behaviorCase(new FXBehaviorNodeCustomAttributeSplit("velocity", VEC3), [
      bind("positionX", "n", "x"),
    ]),
    behaviorCase(new FXBehaviorNodeBuiltinAttribute(), [bind("positionX", "n", "age")]),
    behaviorCase(
      new FXBehaviorNodeStoreAttribute("tint", VEC4, FXBehaviorPhase.SPAWN),
      [bind(attributeSlot("tint"), "n", "value")],
      { v: behaviorReg.create("constant", { type: "vec4", value: [1, 0, 0, 1], phase: "spawn" }) },
      [edge("v", "out", "n", "value")],
    ),
    behaviorCase(new FXBehaviorNodeTimelineValue("power", FLOAT, 1), [
      bind("positionX", "n", "out"),
    ]),
  ];
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
 * trips the single-source contract below. The classes are imported explicitly: the runtime
 * `sparcoon` entry does not re-export the editor node classes.
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
  it("covers every manual node class", () => {
    const covered = CASES.map((testCase) => metaKey(testCase)).sort();
    expect(covered).toEqual(MANUAL_CLASSES.map((cls) => metaKey(cls.describe())).sort());
  });

  for (const testCase of CASES) {
    it(`${testCase.domain}:${testCase.type} reads only what it declares and describes`, () => {
      // Every manual node declares its reads, so validation checks it before compile.
      const declared = testCase.node.targetReads ?? [];
      expect(testCase.node.targetReads).toBeDefined();
      const meta = METAS_BY_KEY.get(metaKey(testCase));
      expect(meta).toBeDefined();
      const described = meta?.reads === "dynamic" ? undefined : meta?.reads;
      const actual = recordReads(testCase.node, testCase.compile);
      // The harness must have actually run build() and hit the reads (not vacuous).
      if (declared.length > 0) {
        expect(actual.length).toBeGreaterThan(0);
      }
      // The declared reads cover every actual read, and the palette meta's reads (unless
      // "dynamic") cover both.
      for (const name of actual) {
        expect(declared).toContain(name);
        if (described !== undefined) {
          expect(described).toContain(name);
        }
      }
      for (const name of declared) {
        if (described !== undefined) {
          expect(described).toContain(name);
        }
      }
    });
  }
});

describe("manual node meta matches the instantiated class's sockets", () => {
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
