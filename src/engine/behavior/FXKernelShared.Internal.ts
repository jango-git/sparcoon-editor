import { FX_FUNCTIONS } from "../core/ir/FXFunctions.Internal";
import type { FXAssetKind } from "../core/nodes/FXAssetKind";
import type { FXValueType } from "../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../core/socket/FXValueType";
import { FX_BEHAVIOR_FUNCTIONS } from "./FXBehaviorFunctions.Internal";
import type { FXKernelBindingHandle, FXKernelResourceFields } from "./FXCompiledKernel";

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

/** The update kernel's parameters, in order - one list for every builder printing one. */
export const UPDATE_KERNEL_PARAMETERS: readonly string[] = [
  SLOTS_PARAMETER,
  "count",
  "dt",
  "bindings",
  "emitter",
];

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

/** The field listing the resources of each asset kind. */
const RESOURCE_FIELDS: Readonly<Record<FXAssetKind, keyof FXKernelResourceFields>> = {
  mesh: "meshSurfaces",
  volume: "volumes",
};

/** What a resource of each asset kind is read through, and the name hint of its JS binding. */
export const KERNEL_RESOURCE_KINDS: Readonly<
  Record<FXAssetKind, { readonly sampler: FXValueType; readonly hint: string }>
> = {
  mesh: { sampler: FX_VALUE_TYPES.sampler2D, hint: "surface" },
  volume: { sampler: FX_VALUE_TYPES.sampler3D, hint: "volume" },
};

/**
 * The resources one phase reads - each asset named once, by `declare`, however many nodes read it.
 * Shared by both backends' kernel states, which only name and declare differently.
 */
export class FXKernelResources {
  private readonly names = new Map<FXAssetKind, Map<string, string>>();

  /** The name the phase reads asset `name` of `kind` under, from `declare` on its first use. */
  public nameOf(kind: FXAssetKind, name: string, declare: () => string): string {
    let names = this.names.get(kind);
    if (names === undefined) {
      names = new Map();
      this.names.set(kind, names);
    }
    let read = names.get(name);
    if (read === undefined) {
      read = declare();
      names.set(name, read);
    }
    return read;
  }

  /** The phase's resource fields. */
  public fields(): FXKernelResourceFields {
    const fields: Record<string, Record<string, string>> = {};
    for (const [kind, names] of this.names) {
      const field: Record<string, string> = {};
      for (const [name, read] of names) {
        field[read] = name;
      }
      fields[RESOURCE_FIELDS[kind]] = field;
    }
    return fields;
  }
}

/** The asset of `kind` each resource of `kernel` reads, both phases' together, by the name it is
 *  read under. Absent when none (the artifacts' `meshSurfaces` / `volumes`). */
export function kernelResources(
  kernel: { readonly spawn?: FXKernelResourceFields; readonly update: FXKernelResourceFields },
  kind: FXAssetKind,
): Readonly<Record<string, string>> | undefined {
  const field = RESOURCE_FIELDS[kind];
  const spawn = kernel.spawn?.[field];
  const update = kernel.update[field];
  return spawn === undefined && update === undefined ? undefined : { ...spawn, ...update };
}

/** Both phases' resource fields together - the fused GPU program's. */
export function kernelResourceFields(kernel: {
  readonly spawn?: FXKernelResourceFields;
  readonly update: FXKernelResourceFields;
}): FXKernelResourceFields {
  const fields: Record<string, Readonly<Record<string, string>>> = {};
  for (const kind of Object.keys(RESOURCE_FIELDS) as FXAssetKind[]) {
    const resources = kernelResources(kernel, kind);
    if (resources !== undefined) {
      fields[RESOURCE_FIELDS[kind]] = resources;
    }
  }
  return fields;
}

/** Just the resource fields of `fields` (a phase or a GPU program), each copied: an artifact's. */
export function resourceFieldsOf(fields: FXKernelResourceFields): FXKernelResourceFields {
  return {
    ...(fields.meshSurfaces === undefined ? {} : { meshSurfaces: { ...fields.meshSurfaces } }),
    ...(fields.volumes === undefined ? {} : { volumes: { ...fields.volumes } }),
  };
}

/** The names a phase reads its resources under. */
export function resourceNames(fields: FXKernelResourceFields): readonly string[] {
  return [...Object.keys(fields.meshSurfaces ?? {}), ...Object.keys(fields.volumes ?? {})];
}
