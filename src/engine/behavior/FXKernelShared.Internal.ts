import type { FXKernelBindingHandle } from "./FXCompiledKernel";
import { FX_FUNCTIONS } from "../core/ir/FXFunctions.Internal";
import { FX_BEHAVIOR_FUNCTIONS } from "./FXBehaviorFunctions.Internal";

/**
 * Primitives shared across the behavior-kernel compile family (validation, the compile driver,
 * the `new Function` builders): buffer name/access helpers, the resolved function map, and the
 * kernel-execution types. Kept here so those files can share them without an import cycle.
 */

/** The packed `mat4 builtin` state buffer name - always present, always integrated. */
export const BUILTIN_BUFFER = "builtin";

/** A named set of per-particle state buffers passed to a kernel (`builtin` + attributes). */
export type FXKernelBuffers = Readonly<Record<string, Float32Array>>;

/**
 * The emitter's world transform, supplied by the runtime each spawn/update call so a graph
 * can simulate in world space (`worldMatrix`/`velocity`/`angularVelocity`, read through the
 * `world-matrix`/`object-velocity`/`object-angular-velocity` nodes). Optional - a graph
 * reading none of these never touches it.
 */
export interface FXEmitterTransform {
  readonly worldMatrix: readonly number[];
  readonly velocity: readonly number[];
  readonly angularVelocity: readonly number[];
}

/** Core + behavior-only functions, the map the JS printer resolves `call` against. */
export const FX_BEHAVIOR_ALL_FUNCTIONS = new Map([...FX_FUNCTIONS, ...FX_BEHAVIOR_FUNCTIONS]);

/** Compiled update kernel: mutates every live particle in `[0, count)` each frame. */
export type FXParticleUpdateKernel = (
  buffers: FXKernelBuffers,
  count: number,
  dt: number,
  bindings: Readonly<Record<string, FXKernelBindingHandle>>,
  emitter?: FXEmitterTransform,
) => void;

/** Compiled spawn kernel: initializes the freshly born particles in `[start, start + count)`. */
export type FXParticleSpawnKernel = (
  buffers: FXKernelBuffers,
  start: number,
  count: number,
  bindings: Readonly<Record<string, FXKernelBindingHandle>>,
  emitter?: FXEmitterTransform,
) => void;

/** Hoisted local holding a state buffer's `Float32Array` (`const s_<name> = buffers[...]`). */
export function bufferArrayName(name: string): string {
  return `s_${name}`;
}

/** Per-particle base offset local for a buffer (`const b_<name> = i * stride`). */
export function bufferBaseName(name: string): string {
  return `b_${name}`;
}

/** A buffer element accessor: `s_<name>[b_<name> + offset]`. */
export function bufferAccess(name: string, offset: number): string {
  return `${bufferArrayName(name)}[${bufferBaseName(name)} + ${offset.toString()}]`;
}
