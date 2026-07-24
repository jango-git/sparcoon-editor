import type { GraphNode } from "../../domain/graphModel";
import { t } from "../../i18n";
import { createElement } from "../dom";
import { AssetPicker } from "../components/assetPicker";
import { COL_END, COL_IN_DOT, type NodeRow } from "./nodeGrid";
import type { NodeWidgets } from "./nodeWidgets";

/** A selectable texture asset for a Texture node's picker (its name + display label). */
export interface TextureAssetOption {
  readonly name: string;
  readonly label: string;
  /** The base64 image, painted as the node's preview once this asset is chosen. */
  readonly dataUrl: string;
}

/**
 * Grid rows a Texture's preview thumbnail occupies below its picker. A whole number of cells
 * (rows x 24px) so the block stays grid-aligned and the card's height keeps snapping to the grid.
 */
const TEXTURE_PREVIEW_ROW_SPAN = 5;

/**
 * The texture picker for a Texture node: an {@link AssetPicker} over the library's uploaded assets,
 * plus a preview thumbnail of the chosen asset in a full-width block below it. Choosing one
 * commits the asset name into the node's `name` parameter (its external sampler slot) and repaints
 * the preview; with no assets yet it shows a hint pointing at the Assets library (no preview).
 */
export function buildTextureAssetRows(
  node: GraphNode,
  key: string,
  options: readonly TextureAssetOption[],
  dependencies: {
    readonly widgets: NodeWidgets;
    readonly onParamChange?: ((key: string, value: unknown) => void) | undefined;
    readonly labelledRow: (label: HTMLElement, control: HTMLElement) => NodeRow;
    readonly scale?: (() => number) | undefined;
  },
): NodeRow[] {
  const label = createElement("span", {
    className: "param__label",
    textContent: t("graph.texture"),
  });
  const current = String(node.parameters[key] ?? "");

  if (options.length === 0) {
    const placeholder = createElement("span", {
      className: "param__placeholder",
      textContent: t("graph.uploadTextureHint"),
    });
    return [dependencies.labelledRow(label, placeholder)];
  }

  // A centred square: the outer block fills the grid cell and centres the square inner layer,
  // whose height (a definite percentage) drives its `aspect-ratio` width. The texture is a
  // `contain` background layered (via a custom property) over the checker - set through the
  // property, not `background-image`, so it never clobbers the checker, and (unlike an <img>)
  // its intrinsic pixel size never leaks into the card's max-content width measurement.
  const image = createElement("div", { className: "texture-preview__image" });
  const preview = createElement("div", { className: "texture-preview" }, [image]);
  const paintPreview = (name: string): void => {
    const chosen = options.find((option) => option.name === name);
    image.style.setProperty(
      "--preview-texture",
      chosen === undefined ? "none" : `url("${chosen.dataUrl}")`,
    );
    preview.classList.toggle("texture-preview--empty", chosen === undefined);
  };

  const picker = new AssetPicker({
    options: options.map((option) => ({
      name: option.name,
      label: option.label,
      thumbnailUrl: option.dataUrl,
    })),
    value: current,
    placeholder: "-",
    onChange: (name): void => {
      dependencies.onParamChange?.(key, name);
      paintPreview(name);
    },
    scale: dependencies.scale,
  });
  dependencies.widgets.track(picker);
  paintPreview(current);
  // One syncer for the `name` parameter keeps both the picker and the preview in step on
  // undo/redo (the Map is keyed by parameter, so picker + preview must share this single entry).
  dependencies.widgets.registerSyncer(key, (value) => {
    const name = String(value ?? "");
    picker.setValue(name);
    paintPreview(name);
  });

  // Swallow pointerdown on the preview so it never starts a node drag.
  preview.addEventListener("pointerdown", (event) => event.stopPropagation());
  return [
    dependencies.labelledRow(label, picker.element),
    {
      cells: [{ element: preview, col: COL_IN_DOT, colEnd: COL_END }],
      span: TEXTURE_PREVIEW_ROW_SPAN,
    },
  ];
}
