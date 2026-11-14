import type { GraphNode } from "../../domain/graphModel";
import { t } from "../../i18n";
import { AssetPicker, type AssetPickerOption } from "../components/assetPicker";
import { createElement } from "../dom";
import type { NodeRow } from "./nodeGrid";
import type { NodeWidgets } from "./nodeWidgets";

/**
 * The mesh picker of a node with a `mesh-asset` parameter (Random Mesh Point): an {@link AssetPicker}
 * over the library's mesh assets. Choosing one commits its name into parameter `key`; with no
 * mesh assets yet it shows a hint pointing at the Assets library.
 */
export function buildMeshAssetRow(
  node: GraphNode,
  key: string,
  options: readonly AssetPickerOption[],
  dependencies: {
    readonly widgets: NodeWidgets;
    readonly onParamChange?: ((key: string, value: unknown) => void) | undefined;
    readonly labelledRow: (label: HTMLElement, control: HTMLElement) => NodeRow;
    readonly scale?: (() => number) | undefined;
  },
): NodeRow {
  const label = createElement("span", { className: "param__label", textContent: t("graph.mesh") });
  if (options.length === 0) {
    const placeholder = createElement("span", {
      className: "param__placeholder",
      textContent: t("graph.uploadMeshHint"),
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
