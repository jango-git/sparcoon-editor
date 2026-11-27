import { FX_OBJECT_ENTRIES, type FXKernelResourceField, fxObjectInputNames } from "sparcoon";
import type { FXAppAssets } from "sparcoon/editor";

import type { FXCompilerErrorCode } from "../compiler/FXCompilerError";
import { FX_VALUE_TYPES, type FXValueType } from "../socket/FXValueType";
import type { FXCustomParamMeta } from "./FXSocketSpec";

/**
 * A kind of content-library asset a behavior node samples, which the app supplies by its name - a
 * mesh read as a shape (its surface table, in its own space), a mesh of the scene (its surface
 * table and its world matrix), a skinned mesh of the scene (its surface table and its skeleton's
 * pose) or a volume (an R8 3D texture).
 */
export type FXAssetKind = "mesh" | "sceneMesh" | "skinnedMesh" | "volume";

/**
 * An input a kernel reads an asset's resource through beside its table: a uniform of the GPU
 * program, a binding of the JS phase. A kernel has it when its code calls one of `readBy` on the
 * table. A `movingOnly` input is kept by the runtime only for a table whose velocity the kernel
 * reads, so a JS phase binds it only then.
 */
export interface FXAssetInput {
  readonly name: string;
  readonly glslTypeName: string;
  readonly length?: number;
  readonly readBy: readonly string[];
  readonly movingOnly?: true;
}

/** How each kind of asset is picked, read by a kernel, checked, and supplied by the app. */
export interface FXAssetKindSpec {
  /** The custom-param kind of a node param picking one. */
  readonly paramKind: FXCustomParamMeta["kind"];
  /** The artifact field naming a kernel's assets of this kind, by binding or sampler uniform. */
  readonly resourceField: FXKernelResourceField;
  /** What its table is read through, and the name hint of its JS binding. */
  readonly sampler: FXValueType;
  readonly hint: string;
  /** The inputs beside the table, named after the table's (an object's pose). */
  readonly inputs: (table: string) => readonly FXAssetInput[];
  /** The function whose call on the table means the kernel reads the velocity of its points, for
   *  an asset the runtime keeps a previous pose of (`movingSurfaces`). */
  readonly movingReadBy?: string;
  /** The error of a node picking one the library does not hold, and the noun its message uses. */
  readonly missing: { readonly code: FXCompilerErrorCode; readonly noun: string };
  /** The field of sparcoon's app assets (`fromArtifacts` options) the app passes it in, which of
   *  the assets there are of this kind, and the type the exported effect asks for it as. */
  readonly appField: FXAppAssetField;
  readonly appAccepts: (asset: FXAppAssets[FXAppAssetField][string]) => boolean;
  readonly appType: string;
}

/** A field of sparcoon's app assets, holding the assets of one kind by name. */
export type FXAppAssetField = keyof FXAppAssets;

const NO_INPUTS = (): readonly FXAssetInput[] => [];
const EVERY_ASSET = (): boolean => true;

/** Whether an app asset is a skinned mesh, duck-typed as the runtime tells one. */
function isSkinnedMesh(asset: unknown): boolean {
  return (asset as { isSkinnedMesh?: boolean }).isSkinnedMesh === true;
}

/** The entries of an object's pose, which every point and its velocity read. */
function objectEntriesOf(table: string): FXAssetInput {
  return {
    name: fxObjectInputNames(table).entries,
    glslTypeName: "vec4",
    length: FX_OBJECT_ENTRIES,
    readBy: ["objectEntry", "previousObjectEntry"],
  };
}

export const FX_ASSET_KINDS: Readonly<Record<FXAssetKind, FXAssetKindSpec>> = {
  mesh: {
    paramKind: "mesh-asset",
    resourceField: "meshSurfaces",
    sampler: FX_VALUE_TYPES.sampler2D,
    hint: "surface",
    inputs: NO_INPUTS,
    missing: { code: "missing-mesh-asset", noun: "mesh" },
    appField: "geometries",
    appAccepts: EVERY_ASSET,
    appType: "BufferGeometry",
  },
  sceneMesh: {
    paramKind: "scene-mesh-asset",
    resourceField: "objectSurfaces",
    sampler: FX_VALUE_TYPES.sampler2D,
    hint: "object",
    inputs: (table) => [objectEntriesOf(table)],
    movingReadBy: "previousObjectEntry",
    missing: { code: "missing-scene-mesh-asset", noun: "static mesh" },
    appField: "meshes",
    appAccepts: (asset) => !isSkinnedMesh(asset),
    appType: "Mesh",
  },
  skinnedMesh: {
    paramKind: "skinned-mesh-asset",
    resourceField: "skinnedSurfaces",
    sampler: FX_VALUE_TYPES.sampler2D,
    hint: "skinned",
    inputs: (table) => {
      const names = fxObjectInputNames(table);
      return [
        objectEntriesOf(table),
        { name: names.bones, glslTypeName: "sampler2D", readBy: ["boneFetch"] },
        {
          name: names.previousBones,
          glslTypeName: "sampler2D",
          readBy: ["previousBoneFetch"],
          movingOnly: true,
        },
      ];
    },
    movingReadBy: "previousObjectEntry",
    missing: { code: "missing-skinned-mesh-asset", noun: "skinned mesh" },
    appField: "meshes",
    appAccepts: isSkinnedMesh,
    appType: "SkinnedMesh",
  },
  volume: {
    paramKind: "volume-asset",
    resourceField: "volumes",
    sampler: FX_VALUE_TYPES.sampler3D,
    hint: "volume",
    inputs: NO_INPUTS,
    missing: { code: "missing-volume-asset", noun: "volume" },
    appField: "volumes",
    appAccepts: EVERY_ASSET,
    appType: "Data3DTexture",
  },
};

export const FX_ASSET_KIND_LIST = Object.keys(FX_ASSET_KINDS) as readonly FXAssetKind[];

/** `value` of each kind of asset. */
export function mapAssetKinds<T>(value: (kind: FXAssetKind) => T): Record<FXAssetKind, T> {
  return Object.fromEntries(FX_ASSET_KIND_LIST.map((kind) => [kind, value(kind)])) as Record<
    FXAssetKind,
    T
  >;
}

/** One asset a node samples. */
export interface FXAssetRead {
  readonly kind: FXAssetKind;
  readonly name: string;
}

/** A node param picking an asset. */
export interface FXAssetParam {
  readonly key: string;
  readonly kind: FXAssetKind;
}

/** The params of a node of `metadata` that pick an asset, in declaration order. */
export function assetParamsOf(
  metadata: { readonly customParams?: readonly FXCustomParamMeta[] } | undefined,
): FXAssetParam[] {
  return (metadata?.customParams ?? []).flatMap((parameter) => {
    const kind = FX_ASSET_KIND_LIST.find(
      (assetKind) => FX_ASSET_KINDS[assetKind].paramKind === parameter.kind,
    );
    return kind === undefined ? [] : [{ key: parameter.key, kind }];
  });
}
