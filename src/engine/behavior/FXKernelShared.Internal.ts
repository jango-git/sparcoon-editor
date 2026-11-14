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

/** Compiled spawn kernel: initializes the freshly born particles in `[start, start + count)`,
 *  every one of them inheriting `inherited` (the target's inherit layout). */
export type FXParticleSpawnKernel = (
  slots: Float32Array,
  start: number,
  count: number,
  bindings: Readonly<Record<string, FXKernelBindingHandle>>,
  emitter: FXEmitterTransform,
  inherited: Float32Array,
) => void;

/** The spawn kernel's inherited values (see `FXKernelTargetInput.inheritOffset`). */
export const INHERITED_PARAMETER = "inherited";

/** The spawn kernel's parameters, in order - one list for every builder printing one. */
export const SPAWN_KERNEL_PARAMETERS: readonly string[] = [
  SLOTS_PARAMETER,
  "start",
  "count",
  "bindings",
  "emitter",
  INHERITED_PARAMETER,
];

/** Per-particle offset local of a buffer's field in the slots (`const b_<name> = i * stride +
 *  field offset`). */
export function bufferBaseName(name: string): string {
  return `b_${name}`;
}

/** A buffer element accessor: `slots[b_<name> + offset]`. */
export function bufferAccess(name: string, offset: number): string {
  return `${SLOTS_PARAMETER}[${bufferBaseName(name)} + ${offset.toString()}]`;
}

/**
 * The mesh surfaces one phase reads, by mesh asset: each named once, by `declare`, however many
 * nodes read it. Shared by both backends' kernel states, which only name and declare differently.
 */
export class FXKernelSurfaces {
  private readonly names = new Map<string, string>();

  /** The name the phase reads `mesh`'s table under, from `declare` on its first use. */
  public nameOf(mesh: string, declare: () => string): string {
    let name = this.names.get(mesh);
    if (name === undefined) {
      name = declare();
      this.names.set(mesh, name);
    }
    return name;
  }

  /** The phase's `surfaces` field: each table's mesh by its name; absent when none. */
  public phaseField(): { surfaces?: Record<string, string> } {
    if (this.names.size === 0) {
      return {};
    }
    const surfaces: Record<string, string> = {};
    for (const [mesh, name] of this.names) {
      surfaces[name] = mesh;
    }
    return { surfaces };
  }
}

/** The mesh asset each surface of `kernel` samples, both phases' together; absent when none (the
 *  artifacts' `meshSurfaces`). */
export function kernelMeshSurfaces(kernel: {
  readonly spawn?: { readonly surfaces?: Readonly<Record<string, string>> };
  readonly update: { readonly surfaces?: Readonly<Record<string, string>> };
}): Readonly<Record<string, string>> | undefined {
  const { spawn, update } = kernel;
  return spawn?.surfaces === undefined && update.surfaces === undefined
    ? undefined
    : { ...spawn?.surfaces, ...update.surfaces };
}
