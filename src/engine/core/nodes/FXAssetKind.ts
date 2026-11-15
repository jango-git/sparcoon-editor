import type { FXCustomParamMeta } from "./FXSocketSpec";

/**
 * A kind of content-library asset a behavior node samples, which the app supplies by its name - a
 * mesh (read as its surface table) or a volume (an R8 3D texture).
 */
export type FXAssetKind = "mesh" | "volume";

/** One asset a node samples. */
export interface FXAssetRead {
  readonly kind: FXAssetKind;
  readonly name: string;
}

/** The custom-param kind of a node param picking an asset of each kind. */
export const FX_ASSET_PARAM_KINDS: Readonly<Record<FXAssetKind, FXCustomParamMeta["kind"]>> = {
  mesh: "mesh-asset",
  volume: "volume-asset",
};

/** A node param picking an asset. */
export interface FXAssetParam {
  readonly key: string;
  readonly kind: FXAssetKind;
}

/** The params of a node of `metadata` that pick an asset, in declaration order. */
export function assetParamsOf(
  metadata: { readonly customParams?: readonly FXCustomParamMeta[] } | undefined,
): FXAssetParam[] {
  const kinds = Object.keys(FX_ASSET_PARAM_KINDS) as FXAssetKind[];
  return (metadata?.customParams ?? []).flatMap((parameter) => {
    const kind = kinds.find((assetKind) => FX_ASSET_PARAM_KINDS[assetKind] === parameter.kind);
    return kind === undefined ? [] : [{ key: parameter.key, kind }];
  });
}
