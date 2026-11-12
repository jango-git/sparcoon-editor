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

/** One zeroed `Float32Array` per state buffer the compiled kernel declares (core + attributes). */
export function buffersFor(compiled: FXCompiledKernel, count = 1): FieldBuffers {
  return fieldsFor(compiled.update.buffers, count);
}

/** The compiled spawn kernel, called on per-field arrays (see `overFields`). */
export function fieldSpawnKernel(compiled: FXCompiledKernel): FieldKernel<FXParticleSpawnKernel> {
  return overFields(compiled.update.buffers, buildParticleSpawnKernel(compiled));
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
  /** Seeds state before the run, e.g. `{ lifecycle: [age, lifetime], position: [x, y, z] }`. */
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
