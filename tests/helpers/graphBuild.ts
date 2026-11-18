import { FX_CORE_LIFECYCLE, FX_CORE_LIFECYCLE_STRIDE, FX_LIFETIME } from "sparcoon";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXCompiledKernel } from "../../src/engine/behavior/FXCompiledKernel";
import type {
  FXEmitterTransform,
  FXParticleSpawnKernel,
  FXParticleUpdateKernel,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import {
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  compileBehavior,
  compileParticleBehavior,
} from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import type { FXBehaviorTargets } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import type { FXConnection, FXOutputBinding } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXGraphNode } from "../../src/engine/core/FXGraphNode";
import { type FieldBuffers, type FieldKernel, fieldsFor, overFields } from "./slots";

/**
 * Graph-building and CPU-kernel helpers shared by the node and behavior tests: the
 * `bind`/`edge` wiring shorthands, a one-call graph constructor, and a runner that compiles a
 * behavior graph on the JS backend and executes one spawn or update invocation over freshly
 * allocated state buffers - per-field arrays, interleaved into the kernel's slots around the call.
 */

/** Binds `nodeId.socketKey` to a target output slot, optionally scoped to one phase. */
export function bind(
  slot: string,
  nodeId: string,
  socketKey: string,
  phase?: "spawn" | "update",
): FXOutputBinding {
  return { slot, from: { nodeId, socketKey }, ...(phase !== undefined && { phase }) };
}

/** Connects `fromNode.fromKey` to `toNode.toKey`. */
export function edge(
  fromNode: string,
  fromKey: string,
  toNode: string,
  toKey: string,
): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

/** A graph ingested from a node record, its connections and its output bindings. */
export function graphOf<N extends FXGraphNode>(
  nodes: Readonly<Record<string, N>>,
  connections: readonly FXConnection[] = [],
  outputBindings: readonly FXOutputBinding[] = [],
): FXGraph<N> {
  const graph = new FXGraph<N>();
  graph.ingest({ nodes: new Map(Object.entries(nodes)), connections, outputBindings });
  return graph;
}

/**
 * The core lifecycle of `count` live particles, at age 0 of a 1 second life: the update skips a
 * particle whose age is not below its lifetime.
 */
export function liveLifecycle(count = 1): Float32Array {
  const lifecycle = new Float32Array(FX_CORE_LIFECYCLE_STRIDE * count);
  for (let i = 0; i < count; i++) {
    lifecycle[i * FX_CORE_LIFECYCLE_STRIDE + FX_LIFETIME] = 1;
  }
  return lifecycle;
}

/**
 * One `Float32Array` per state buffer the compiled kernel declares (core + attributes), zeroed
 * except for a {@link liveLifecycle}.
 */
export function buffersFor(compiled: FXCompiledKernel, count = 1): FieldBuffers {
  const fields = fieldsFor(compiled.update.buffers, count);
  if (FX_CORE_LIFECYCLE in fields) {
    fields[FX_CORE_LIFECYCLE] = liveLifecycle(count);
  }
  return fields;
}

/** The pose of an emitter at the world origin, at rest. */
const IDENTITY_EMITTER: FXEmitterTransform = {
  worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  velocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
};

/** A spawn kernel over per-field arrays, born at rest at the origin and inheriting the compiled
 *  defaults unless told otherwise. */
export type FieldSpawnKernel = (
  fields: FieldBuffers,
  start: number,
  count: number,
  bindings: Parameters<FieldKernel<FXParticleSpawnKernel>>[3],
  emitter?: FXEmitterTransform,
  inherited?: Float32Array,
) => void;

/** The compiled spawn kernel, called on per-field arrays (see `overFields`). */
export function fieldSpawnKernel(compiled: FXCompiledKernel): FieldSpawnKernel {
  const run = overFields(compiled.update.buffers, buildParticleSpawnKernel(compiled));
  return (fields, start, count, bindings, emitter, inherited): void => {
    run(
      fields,
      start,
      count,
      bindings,
      emitter ?? IDENTITY_EMITTER,
      inherited ?? Float32Array.from(compiled.inherit?.layout.defaults ?? []),
    );
  };
}

/** The compiled update kernel, called on per-field arrays (see `overFields`). */
export function fieldUpdateKernel(compiled: FXCompiledKernel): FieldKernel<FXParticleUpdateKernel> {
  return overFields(compiled.update.buffers, buildParticleUpdateKernel(compiled));
}

/** Options for {@link runKernel}. */
export interface RunKernelOptions {
  /** Phase to execute (default `"update"`). */
  readonly phase?: "spawn" | "update";
  /** Targets to compile against (default: the particle targets with the graph's attributes). */
  readonly targets?: FXBehaviorTargets;
  /** Particle count (default 1). */
  readonly count?: number;
  /** Update timestep (default 0.016; ignored by spawn). */
  readonly dt?: number;
  /**
   * Seeds state before the run, e.g. `{ lifecycle: [age, lifetime, id], position: [x, y, z] }`.
   * Particles are alive unless seeded otherwise; the update skips one whose age is not below its
   * lifetime.
   */
  readonly state?: Readonly<Record<string, readonly number[]>>;
  /** Emitter transform handed to the kernel. */
  readonly emitter?: FXEmitterTransform;
}

/**
 * Compiles a behavior graph on the JS backend, runs one invocation of the chosen phase over
 * fresh state buffers and returns those buffers.
 */
export function runKernel(
  graph: FXGraph<FXBehaviorNode>,
  options: RunKernelOptions = {},
): FieldBuffers {
  const { phase = "update", targets, count = 1, dt = 0.016, state = {}, emitter } = options;
  const compiled =
    targets !== undefined ? compileBehavior(graph, targets) : compileParticleBehavior(graph);
  const buffers = buffersFor(compiled, count);
  for (const [name, values] of Object.entries(state)) {
    buffers[name].set(values);
  }
  if (phase === "spawn") {
    fieldSpawnKernel(compiled)(buffers, 0, count, compiled.spawn!.bindings, emitter);
  } else {
    fieldUpdateKernel(compiled)(buffers, count, dt, compiled.update.bindings, emitter);
  }
  return buffers;
}
