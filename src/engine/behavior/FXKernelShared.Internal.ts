import type { FXBehaviorArtifact } from "sparcoon";

import { FX_FUNCTIONS } from "../core/ir/FXFunctions.Internal";
import type { FXAssetKind } from "../core/nodes/FXAssetKind";
import type { FXValueType } from "../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../core/socket/FXValueType";
import { FX_BEHAVIOR_FUNCTIONS } from "./FXBehaviorFunctions.Internal";
import type { FXKernelResourceFields } from "./FXCompiledKernel";

export const BUILTIN_BUFFER = "builtin";

/**
 * The kernel's one state array, every particle's slot back to back: a target's buffers lie in each
 * slot in the order the target declares them (sparcoon's `slotLayout`, which places the fields).
 */
export const SLOTS_PARAMETER = "slots";

export const FX_BEHAVIOR_ALL_FUNCTIONS = new Map([...FX_FUNCTIONS, ...FX_BEHAVIOR_FUNCTIONS]);

export type FXParticleUpdateKernel = FXBehaviorArtifact["update"];

export type FXParticleSpawnKernel = NonNullable<FXBehaviorArtifact["spawn"]>;

export const INHERITED_PARAMETER = "inherited";

export const UPDATE_KERNEL_PARAMETERS: readonly string[] = [
  SLOTS_PARAMETER,
  "count",
  "dt",
  "seed",
  "bindings",
  "emitter",
];

export const SPAWN_KERNEL_PARAMETERS: readonly string[] = [
  SLOTS_PARAMETER,
  "start",
  "count",
  "seed",
  "bindings",
  "emitter",
  INHERITED_PARAMETER,
];

export function bufferBaseName(name: string): string {
  return `b_${name}`;
}

export function bufferAccess(name: string, offset: number): string {
  return `${SLOTS_PARAMETER}[${bufferBaseName(name)} + ${offset.toString()}]`;
}

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

export function resourceFieldsOf(fields: FXKernelResourceFields): FXKernelResourceFields {
  return {
    ...(fields.meshSurfaces === undefined ? {} : { meshSurfaces: { ...fields.meshSurfaces } }),
    ...(fields.volumes === undefined ? {} : { volumes: { ...fields.volumes } }),
  };
}

export function resourceNames(fields: FXKernelResourceFields): readonly string[] {
  return [...Object.keys(fields.meshSurfaces ?? {}), ...Object.keys(fields.volumes ?? {})];
}
