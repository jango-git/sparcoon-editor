import type { FXCompilerContext } from "../compiler/FXCompilerContext";
import type { FXExpr } from "../ir/FXExpr";
import type { FXAssetKind, FXAssetRead } from "./FXAssetKind";

/**
 * The assets a {@link defineNode} node samples: each picked by a param of its key, `""` while none
 * is. A pick is structural - the resource it reads is declared in the code.
 */
export class FXDescriptorAssets {
  private readonly picks = new Map<string, string>();

  constructor(private readonly kinds: Readonly<Record<string, FXAssetKind>>) {
    for (const key of Object.keys(kinds)) {
      this.picks.set(key, "");
    }
  }

  /** Takes each pick from `parameters`; an absent one (a project saved before it) is none. */
  public apply(parameters: Readonly<Record<string, unknown>>): void {
    for (const key of this.picks.keys()) {
      const raw = parameters[key];
      this.picks.set(key, typeof raw === "string" ? raw : "");
    }
  }

  /** Each pick by its key. */
  public names(): Record<string, string> {
    return Object.fromEntries(this.picks);
  }

  /** The picks as cache-key parts, tagged apart from params and inputs. */
  public cacheKeyParts(): (readonly [string, string, unknown])[] {
    return [...this.picks].map(([key, name]) => ["a", key, name] as const);
  }

  /** The assets picked. */
  public reads(): FXAssetRead[] {
    return [...this.picks].flatMap(([key, name]) =>
      name === "" ? [] : [{ kind: this.kinds[key] as FXAssetKind, name }],
    );
  }

  /**
   * Each asset as the sampler value `context` reads it through, `undefined` while none is picked.
   * @throws When an asset is picked on a backend that samples none.
   */
  public resolve(context: FXCompilerContext, type: string): Record<string, FXExpr | undefined> {
    const resolved: Record<string, FXExpr | undefined> = {};
    for (const [key, name] of this.picks) {
      if (name === "") {
        resolved[key] = undefined;
      } else if (context.allocateAsset === undefined) {
        throw new Error(`FXDescriptorNode("${type}"): this backend samples no assets`);
      } else {
        resolved[key] = context.allocateAsset(this.kinds[key] as FXAssetKind, name);
      }
    }
    return resolved;
  }
}
