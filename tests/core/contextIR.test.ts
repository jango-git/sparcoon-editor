import { FX_LIFETIME, FX_POSITION_X, FX_POSITION_Y, FX_POSITION_Z } from "sparcoon";
import { describe, expect, it } from "vitest";

import { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { FXBehaviorPhase } from "../../src/engine/behavior/FXBehaviorPhase";
import type { FXKernelContext } from "../../src/engine/behavior/FXKernelContext";
import { compileParticleBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXConnection } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { add, construct, lit, litVec, mul, ref } from "../../src/engine/core/ir/FXExprBuilder";
import type { FXSocketDescriptor } from "../../src/engine/core/socket/FXSocket";
import { FX_VALUE_TYPES, type FXValueType } from "../../src/engine/core/socket/FXValueType";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderContext } from "../../src/engine/render/compiler/FXRenderContext";
import { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXShaderStage } from "../../src/engine/render/FXShaderStage";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { GLSL_NAME } from "../helpers/glslNames";
import { fieldSpawnKernel, fieldUpdateKernel } from "../helpers/graphBuild";

const FLOAT = FX_VALUE_TYPES.float;
const VEC2 = FX_VALUE_TYPES.vec2;
const VEC3 = FX_VALUE_TYPES.vec3;
const VEC4 = FX_VALUE_TYPES.vec4;

function socket(key: string, type: FXSocketDescriptor["type"]): FXSocketDescriptor {
  return { key, type };
}

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

/** A fragment render node whose `build` body is supplied per-instance. */
class TestRenderNode extends FXRenderNode {
  public readonly stage = FXShaderStage.FRAGMENT;
  constructor(
    public readonly type: string,
    public readonly inputs: readonly FXSocketDescriptor[],
    public readonly outputs: readonly FXSocketDescriptor[],
    private readonly buildFn: (ctx: FXRenderContext) => void,
  ) {
    super();
  }
  public build(ctx: FXRenderContext): void {
    this.buildFn(ctx);
  }
}

/** A behavior node whose `build` body and phase are supplied per-instance. */
class TestBehaviorNode extends FXBehaviorNode {
  constructor(
    public readonly type: string,
    public readonly phase: FXBehaviorPhase,
    public readonly inputs: readonly FXSocketDescriptor[],
    public readonly outputs: readonly FXSocketDescriptor[],
    private readonly buildFn: (ctx: FXKernelContext) => void,
  ) {
    super();
  }
  public build(ctx: FXKernelContext): void {
    this.buildFn(ctx);
  }
}

describe("render context IR path", () => {
  const compiler = new FXCompilerBaseline();

  it("prints setOutput / readInput / readTargetInput to GLSL", () => {
    // src: uv = p_uv  (readTargetInput -> setOutput)
    const src = new TestRenderNode("ir-uv", [], [socket("uv", VEC2)], (ctx) => {
      ctx.setOutput("uv", ctx.readTargetInput("p_uv"));
    });
    // sink: albedo = vec4(uv * u_time, 0, 1)  (readInput + builders -> setOutput)
    const sink = new TestRenderNode(
      "ir-color",
      [socket("uv", VEC2)],
      [socket("color", VEC4)],
      (ctx) => {
        const uv = ctx.readInput("uv");
        const t = ctx.readTargetInput("u_time");
        ctx.setOutput("color", construct(VEC4, mul(uv, t), lit(0), lit(1)));
      },
    );

    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map(Object.entries({ src, sink })),
      connections: [edge("src", "uv", "sink", "uv")],
      outputBindings: [{ slot: "albedo", from: { nodeId: "sink", socketKey: "color" } }],
    });
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);

    expect(shader.color.outputs["albedo"]).toMatch(new RegExp(`^${GLSL_NAME}$`));
    const body = shader.color.fragment.body.join("\n");
    // uv materialized from the builtin
    expect(body).toMatch(new RegExp(`vec2 ${GLSL_NAME} = p_uv;`));
    // vec4 assembled from the splat multiply and two literals
    expect(body).toMatch(
      new RegExp(String.raw`vec4 ${GLSL_NAME} = vec4\(\(${GLSL_NAME} \* u_time\), 0\.0, 1\.0\);`),
    );
  });

  it("chains SSA outputs across nodes", () => {
    const producer = new TestRenderNode("uv", [], [socket("uv", VEC2)], (ctx) => {
      ctx.setOutput("uv", ctx.readTargetInput("p_uv"));
    });
    const middle = new TestRenderNode("mid", [socket("uv", VEC2)], [socket("v", VEC4)], (ctx) => {
      ctx.setOutput("v", construct(VEC4, ctx.readInput("uv"), lit(0), lit(1)));
    });
    const tail = new TestRenderNode("tail", [socket("v", VEC4)], [socket("color", VEC4)], (ctx) => {
      ctx.setOutput("color", mul(ctx.readInput("v"), lit(2)));
    });

    const graph = new FXGraph<FXRenderNode>();
    graph.ingest({
      nodes: new Map(Object.entries({ producer, middle, tail })),
      connections: [edge("producer", "uv", "middle", "uv"), edge("middle", "v", "tail", "v")],
      outputBindings: [{ slot: "albedo", from: { nodeId: "tail", socketKey: "color" } }],
    });
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.color.outputs["albedo"]).toMatch(new RegExp(`^${GLSL_NAME}$`));
    expect(shader.color.fragment.body.join("\n")).toContain("* 2.0)");
  });
});

describe("behavior context IR path", () => {
  const core = (): { position: Float32Array; lifecycle: Float32Array } => ({
    position: new Float32Array(3),
    lifecycle: new Float32Array(3),
  });

  it("scalar setOutput writes a core slot", () => {
    const life = new TestBehaviorNode(
      "ir-life",
      FXBehaviorPhase.SPAWN,
      [],
      [socket("value", FLOAT)],
      (ctx) => {
        ctx.setOutput("value", lit(2.5));
      },
    );
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map(Object.entries({ life })),
      connections: [],
      outputBindings: [{ slot: "lifetime", from: { nodeId: "life", socketKey: "value" } }],
    });
    const compiled = compileParticleBehavior(graph);
    const buffers = core();
    fieldSpawnKernel(compiled)(buffers, 0, 1, compiled.spawn!.bindings);
    expect(buffers.lifecycle[FX_LIFETIME]).toBe(2.5);
  });

  it("names spawn's and update's bindings apart: they merge into one set by name", () => {
    const bindingNode = (phase: FXBehaviorPhase, value: number, type: FXValueType) =>
      new TestBehaviorNode(`ir-binding-${phase}`, phase, [], [socket("out", type)], (ctx) => {
        const read = ref("binding", ctx.allocateBinding({ value, hint: "k" }).name, FLOAT);
        ctx.setOutput("out", type === FLOAT ? read : construct(type, read, read, read));
      });
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map(
        Object.entries({
          spawn: bindingNode(FXBehaviorPhase.SPAWN, 1, FLOAT),
          update: bindingNode(FXBehaviorPhase.UPDATE, 2, VEC3),
        }),
      ),
      connections: [],
      outputBindings: [
        {
          slot: "lifetime",
          from: { nodeId: "spawn", socketKey: "out" },
          phase: FXBehaviorPhase.SPAWN,
        },
        {
          slot: "position",
          from: { nodeId: "update", socketKey: "out" },
          phase: FXBehaviorPhase.UPDATE,
        },
      ],
    });
    const compiled = compileParticleBehavior(graph);
    const values = (bindings: Readonly<Record<string, { value: unknown }>> = {}) =>
      Object.values(bindings).map((handle) => handle.value);
    expect(values(compiled.spawn?.bindings)).toEqual([1]);
    expect(values(compiled.update.bindings)).toEqual([2]);
    const spawnNames = Object.keys(compiled.spawn?.bindings ?? {});
    expect(Object.keys(compiled.update.bindings).some((name) => spawnNames.includes(name))).toBe(
      false,
    );
  });

  it("vector setOutput scalarizes into the core vec3 position slot", () => {
    const pos = new TestBehaviorNode(
      "ir-pos",
      FXBehaviorPhase.SPAWN,
      [],
      [socket("v", VEC3)],
      (ctx) => {
        ctx.setOutput("v", litVec(1, 2, 3));
      },
    );
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map(Object.entries({ pos })),
      connections: [],
      outputBindings: [{ slot: "position", from: { nodeId: "pos", socketKey: "v" } }],
    });
    const compiled = compileParticleBehavior(graph);
    const buffers = core();
    fieldSpawnKernel(compiled)(buffers, 0, 1, compiled.spawn!.bindings);
    expect([
      buffers.position[FX_POSITION_X],
      buffers.position[FX_POSITION_Y],
      buffers.position[FX_POSITION_Z],
    ]).toEqual([1, 2, 3]);
  });

  it("readInput round-trips a scalar and a vector between nodes", () => {
    const base = new TestBehaviorNode(
      "ir-base",
      FXBehaviorPhase.SPAWN,
      [],
      [socket("out", VEC3)],
      (ctx) => {
        ctx.setOutput("out", litVec(10, 20, 30));
      },
    );
    const shift = new TestBehaviorNode(
      "ir-shift",
      FXBehaviorPhase.SPAWN,
      [socket("in", VEC3)],
      [socket("out", VEC3)],
      (ctx) => {
        ctx.setOutput("out", add(ctx.readInput("in"), litVec(1, 2, 3)));
      },
    );
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map(Object.entries({ base, shift })),
      connections: [edge("base", "out", "shift", "in")],
      outputBindings: [{ slot: "position", from: { nodeId: "shift", socketKey: "out" } }],
    });
    const compiled = compileParticleBehavior(graph);
    const buffers = core();
    fieldSpawnKernel(compiled)(buffers, 0, 1, compiled.spawn!.bindings);
    expect([
      buffers.position[FX_POSITION_X],
      buffers.position[FX_POSITION_Y],
      buffers.position[FX_POSITION_Z],
    ]).toEqual([11, 22, 33]);
  });

  it("readTargetInput resolves a core builtin to state access in UPDATE", () => {
    const doublePos = new TestBehaviorNode(
      "ir-doublepos",
      FXBehaviorPhase.UPDATE,
      [],
      [socket("out", FLOAT)],
      (ctx) => {
        ctx.setOutput("out", mul(ctx.readTargetInput("PARTICLE_POSITION_Y"), lit(2)));
      },
    );
    const graph = new FXGraph<FXBehaviorNode>();
    graph.ingest({
      nodes: new Map(Object.entries({ doublePos })),
      connections: [],
      outputBindings: [{ slot: "positionY", from: { nodeId: "doublePos", socketKey: "out" } }],
    });
    const compiled = compileParticleBehavior(graph);
    const buffers = core();
    buffers.position[FX_POSITION_Y] = 3;
    fieldUpdateKernel(compiled)(buffers, 1, 0, compiled.update.bindings);
    expect(buffers.position[FX_POSITION_Y]).toBe(6);
  });
});
