import type { FXExpr } from "../core/ir/FXExpr";

/**
 * A value captured from outside the kernel (the behavior analog of a render uniform); `value`
 * is updated in place on edit. A `Float32Array` value is a LUT refilled in place, so an edit
 * rebinds rather than forcing a recompile.
 */
export interface FXKernelBindingDescriptor {
  value: number | Float32Array;
  hint?: string;
  /**
   * Forces a **stable, verbatim** binding name (a param node's user-chosen slot) instead
   * of the auto-numbered `hint`. Two allocations with the same `name` share one binding, so
   * a param addressed by name survives structural edits and a timeline can drive it through
   * {@link FXEmitter.applyValues}. The behavior analog of {@link FXUniformDescriptor.name}.
   */
  name?: string;
}

/** Live handle to a kernel binding, retained by a node for runtime updates. */
export interface FXKernelBindingHandle {
  readonly name: string;
  value: number | Float32Array;
}

/** One state buffer the kernel operates on: its name and per-particle float stride. */
export interface FXKernelBufferLayout {
  readonly name: string;
  readonly stride: number;
}

/**
 * One resolved write into the packed state (a `vec3` slot yields three), resolved at compile
 * time from the target's declared offsets so the kernel builder needs no separate offset table.
 */
export interface FXKernelWrite {
  readonly buffer: string;
  readonly offset: number;
  readonly expr: string;
}

/**
 * One SSA local, accumulated in emission order, then CSE-deduped and printed into the phase
 * `body`/`preLoop` - see `FXKernelState.finalize`.
 */
export interface FXKernelLocal {
  readonly name: string;
  readonly expr: FXExpr;
}

/**
 * A structured epilogue write a custom target may declare (motion integration), printed after
 * the node writes. Default particle targets declare none - motion is an `integrate-motion` node.
 */
export interface FXKernelIntegration {
  readonly offset: number;
  readonly expr: FXExpr;
}

/**
 * One compiled phase (spawn or update) of a behavior kernel, SSA-style like the render IR.
 * Phases run as separate invocations at different times (birth vs. per frame) and share
 * nothing but persisted particle state, so each carries its own helpers/body/writes/bindings.
 */
export interface FXCompiledKernelPhase {
  /** Deduplicated helper function sources, hoisted outside the per-particle loop. */
  readonly helpers: readonly string[];
  /** Particle-invariant locals (bindings/`dt`/emitter transform/constants), hoisted before
   * the loop so they compute once per invocation rather than per particle. */
  readonly preLoop: readonly string[];
  /** Target-provided statements injected at the top of the per-element loop. */
  readonly preamble: readonly string[];
  /** Ordered statements forming the per-particle loop body. */
  readonly body: readonly string[];
  /** State writes (offset + local), applied after the body. Vec3 slots expand to three. */
  readonly writes: readonly FXKernelWrite[];
  /** Target-provided statements injected at the bottom of the loop (e.g. integration). */
  readonly epilogue: readonly string[];
  /** Captured bindings keyed by generated name; passed to the kernel at runtime. */
  readonly bindings: Readonly<Record<string, FXKernelBindingHandle>>;
  /** State buffers this phase reads/writes (name + stride), for base computation. */
  readonly buffers: readonly FXKernelBufferLayout[];
  /** Buffers this phase actually writes - the host marks only these `needsUpdate`. */
  readonly writtenBuffers: readonly string[];
}

/**
 * Backend-independent (no Three) intermediate representation for a compiled
 * behavior graph. A kernel adapter turns each phase into a JS function operating
 * on the particle buffers.
 */
export interface FXCompiledKernel {
  /**
   * Phase run once at particle birth (initial state). Absent when the target has no
   * spawn phase (an update-only, non-particle host) - nothing is seeded at birth.
   */
  readonly spawn?: FXCompiledKernelPhase;
  /** Phase run every frame. */
  readonly update: FXCompiledKernelPhase;
  /** Deterministic structural hash of the whole graph, the recompile gate. */
  readonly hash: string;
}
