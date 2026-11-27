import type { FXBehaviorArtifact } from "sparcoon";

import type { FXExpr } from "../core/ir/FXExpr";
import { FX_FUNCTIONS } from "../core/ir/FXFunctions.Internal";
import { childrenOf, refNamesIn } from "../core/ir/visit.Internal";
import {
  FX_ASSET_KIND_LIST,
  FX_ASSET_KINDS,
  type FXAssetKind,
  mapAssetKinds,
} from "../core/nodes/FXAssetKind";
import { FX_BEHAVIOR_FUNCTIONS } from "./FXBehaviorFunctions.Internal";
import type { FXKernelResourceFields } from "./FXCompiledKernel";
import type { FXKernelUniform } from "./FXKernelUniformsStandard.Internal";

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

/** What a phase's code reads of the resources it named: its artifact fields, and the declarations
 *  of the tables and of the inputs beside them it reads. */
export interface FXResourceReads {
  readonly fields: FXKernelResourceFields;
  readonly declarations: readonly FXKernelUniform[];
}

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

  /** What `exprs`, the phase's live code, read of the resources: a table its code reads, an input
   *  beside it the code calls one of the input's readers on, and the tables whose velocity it
   *  reads. */
  public readIn(exprs: readonly FXExpr[]): FXResourceReads {
    const read = new Set(refNamesIn(exprs, "binding"));
    const readers = firstArgumentsOfCalls(exprs);
    const fields: Record<string, Record<string, string> | string[]> = {};
    const declarations: FXKernelUniform[] = [];
    for (const [kind, names] of this.names) {
      const spec = FX_ASSET_KINDS[kind];
      const field: Record<string, string> = {};
      for (const [name, table] of names) {
        if (!read.has(table)) {
          continue;
        }
        const calls = (reader: string): boolean => readers.get(reader)?.has(table) === true;
        field[table] = name;
        declarations.push({ name: table, glslTypeName: spec.sampler.glslTypeName });
        for (const { name: inputName, glslTypeName, length, readBy } of spec.inputs(table)) {
          if (readBy.some(calls)) {
            declarations.push({
              name: inputName,
              glslTypeName,
              ...(length === undefined ? {} : { length }),
            });
          }
        }
        if (spec.movingReadBy !== undefined && calls(spec.movingReadBy)) {
          ((fields["movingSurfaces"] ??= []) as string[]).push(table);
        }
      }
      if (Object.keys(field).length > 0) {
        fields[spec.resourceField] = field;
      }
    }
    return { fields, declarations };
  }
}

/** The names of the binding refs each function is called on as its first argument in `exprs`. */
function firstArgumentsOfCalls(exprs: readonly FXExpr[]): Map<string, Set<string>> {
  const calls = new Map<string, Set<string>>();
  const visit = (expr: FXExpr): void => {
    const [first] = expr.kind === "call" ? expr.args : [];
    if (expr.kind === "call" && first?.kind === "ref" && first.ref === "binding") {
      let names = calls.get(expr.fn);
      if (names === undefined) {
        names = new Set();
        calls.set(expr.fn, names);
      }
      names.add(first.name);
    }
    for (const child of childrenOf(expr)) {
      visit(child);
    }
  };
  for (const expr of exprs) {
    visit(expr);
  }
  return calls;
}

/** The asset of `kind` each resource of `kernel` reads, both phases' together, by the name it is
 *  read under. Absent when none. */
function kernelResources(
  kernel: { readonly spawn?: FXKernelResourceFields; readonly update: FXKernelResourceFields },
  kind: FXAssetKind,
): Readonly<Record<string, string>> | undefined {
  const field = FX_ASSET_KINDS[kind].resourceField;
  const spawn = kernel.spawn?.[field];
  const update = kernel.update[field];
  return spawn === undefined && update === undefined ? undefined : { ...spawn, ...update };
}

/** The assets `fields` name, by kind - each named once, in name order. */
export function assetNamesOf(
  fields: FXKernelResourceFields,
): Readonly<Record<FXAssetKind, readonly string[]>> {
  return mapAssetKinds((kind) =>
    [...new Set(Object.values(fields[FX_ASSET_KINDS[kind].resourceField] ?? {}))].sort(),
  );
}

/** Both phases' resource fields together - the fused GPU program's. */
export function kernelResourceFields(kernel: {
  readonly spawn?: FXKernelResourceFields;
  readonly update: FXKernelResourceFields;
}): FXKernelResourceFields {
  const fields: Record<string, Readonly<Record<string, string>> | readonly string[]> = {};
  for (const kind of FX_ASSET_KIND_LIST) {
    const resources = kernelResources(kernel, kind);
    if (resources !== undefined) {
      fields[FX_ASSET_KINDS[kind].resourceField] = resources;
    }
  }
  const moving = [
    ...new Set([...(kernel.spawn?.movingSurfaces ?? []), ...(kernel.update.movingSurfaces ?? [])]),
  ].sort();
  if (moving.length > 0) {
    fields["movingSurfaces"] = moving;
  }
  return fields;
}

export function resourceFieldsOf(fields: FXKernelResourceFields): FXKernelResourceFields {
  const copy: Record<string, Readonly<Record<string, string>> | readonly string[]> = {};
  for (const kind of FX_ASSET_KIND_LIST) {
    const field = FX_ASSET_KINDS[kind].resourceField;
    const resources = fields[field];
    if (resources !== undefined) {
      copy[field] = { ...resources };
    }
  }
  if (fields.movingSurfaces !== undefined) {
    copy["movingSurfaces"] = [...fields.movingSurfaces];
  }
  return copy;
}

/** The bindings a JS phase reads its resources through: each resource's own, and the inputs of
 *  its kind beside it - one kept only for a moving surface only for a resource the phase moves. */
export function resourceNames(fields: FXKernelResourceFields): readonly string[] {
  return FX_ASSET_KIND_LIST.flatMap((kind) => {
    const spec = FX_ASSET_KINDS[kind];
    return Object.keys(fields[spec.resourceField] ?? {}).flatMap((name) => [
      name,
      ...spec
        .inputs(name)
        .filter(
          (input) => input.movingOnly !== true || fields.movingSurfaces?.includes(name) === true,
        )
        .map((input) => input.name),
    ]);
  });
}
