import { FX_FUNCTIONS } from "../core/ir/FXFunctions.Internal";
import { FX_BEHAVIOR_FUNCTIONS } from "./FXBehaviorFunctions.Internal";
import type { FXKernelBindingHandle } from "./FXCompiledKernel";

/**
 * Primitives shared across the behavior-kernel compile family (validation, the compile driver,
 * the `new Function` builders): buffer name/access helpers, the resolved function map, and the
 * kernel-execution types. Kept here so those files can share them without an import cycle.
 */

/** The packed `mat4 builtin` state buffer name - always present, always integrated. */
export const BUILTIN_BUFFER = "builtin";

/**
 * The kernel's one state array, every particle's slot back to back: a target's buffers lie in each
 * slot in the order the target declares them (sparcoon's `slotLayout`, which places the fields).
 */
export const SLOTS_PARAMETER = "slots";

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
  slots: Float32Array,
  count: number,
  dt: number,
  bindings: Readonly<Record<string, FXKernelBindingHandle>>,
  emitter?: FXEmitterTransform,
) => void;

/** Compiled spawn kernel: initializes the freshly born particles in `[start, start + count)`. */
export type FXParticleSpawnKernel = (
  slots: Float32Array,
  start: number,
  count: number,
  bindings: Readonly<Record<string, FXKernelBindingHandle>>,
  emitter?: FXEmitterTransform,
) => void;

/** Per-particle offset local of a buffer's field in the slots (`const b_<name> = i * stride +
 *  field offset`). */
export function bufferBaseName(name: string): string {
  return `b_${name}`;
}

/** A buffer element accessor: `slots[b_<name> + offset]`. */
export function bufferAccess(name: string, offset: number): string {
  return `${SLOTS_PARAMETER}[${bufferBaseName(name)} + ${offset.toString()}]`;
}
