import type { GraphNode } from "../../domain/graphModel";
import type { FXAssetKind } from "../../engine/core/nodes/FXAssetKind";
import { t, type TKey } from "../../i18n";
import { AssetPicker, type AssetPickerOption } from "../components/assetPicker";
import { createElement } from "../dom";
import type { NodeRow } from "./nodeGrid";
import type { NodeWidgets } from "./nodeWidgets";

/** The row label of each asset kind's picker, and the hint it shows while the library has none. */
const ASSET_ROW_TEXT: Readonly<
  Record<FXAssetKind, { readonly label: TKey; readonly empty: TKey }>
> = {
  mesh: { label: "graph.mesh", empty: "graph.uploadMeshHint" },
  sceneMesh: { label: "graph.mesh", empty: "graph.uploadSceneMeshHint" },
  skinnedMesh: { label: "graph.mesh", empty: "graph.uploadSkinnedMeshHint" },
  volume: { label: "graph.volume", empty: "graph.bakeVolumeHint" },
};

/**
 * The picker of a node's asset parameter (Random Mesh Point's mesh, SDF Sample's volume) - an
 * {@link AssetPicker} over the library's assets of `kind`. Choosing one commits its name into
 * parameter `key`. With none in the library it shows a hint pointing at the Assets library.
 */
export function buildAssetRow(
  node: GraphNode,
  key: string,
  kind: FXAssetKind,
  options: readonly AssetPickerOption[],
  dependencies: {
    readonly widgets: NodeWidgets;
    readonly onParamChange?: ((key: string, value: unknown) => void) | undefined;
    readonly labelledRow: (label: HTMLElement, control: HTMLElement) => NodeRow;
    readonly scale?: (() => number) | undefined;
  },
): NodeRow {
  const text = ASSET_ROW_TEXT[kind];
  const label = createElement("span", { className: "param__label", textContent: t(text.label) });
  if (options.length === 0) {
    const placeholder = createElement("span", {
      className: "param__placeholder",
      textContent: t(text.empty),
    });
    return dependencies.labelledRow(label, placeholder);
  }
  const picker = new AssetPicker({
    options,
    value: String(node.parameters[key] ?? ""),
    placeholder: "-",
    onChange: (name): void => {
      dependencies.onParamChange?.(key, name);
    },
    scale: dependencies.scale,
  });
  dependencies.widgets.track(picker);
  dependencies.widgets.registerSyncer(key, (value) => {
    picker.setValue(String(value ?? ""));
  });
  return dependencies.labelledRow(label, picker.element);
}
