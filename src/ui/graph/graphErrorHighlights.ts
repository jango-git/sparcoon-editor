import type { LiveApplyStatus } from "../../model/editorState";
import { t } from "../../i18n";
import { attachTooltip, clearTooltip } from "../components/tooltip";
import type { NodeView } from "./nodeView";

/**
 * Paints the compiler's per-node error highlight: a red frame on every node the active graph's
 * last live-apply blamed, with the node's messages as a hover tooltip. Node ids that aren't in
 * `nodeViews` (routes, the other graph) simply find no match.
 */
export function applyErrorHighlights(
  nodeViews: ReadonlyMap<string, NodeView>,
  status: LiveApplyStatus | undefined,
): void {
  const messagesByNode = new Map<string, string[]>();
  for (const error of status?.errors ?? []) {
    if (error.nodeId === undefined) {
      continue;
    }
    const list = messagesByNode.get(error.nodeId) ?? [];
    list.push(error.message);
    messagesByNode.set(error.nodeId, list);
  }
  for (const [id, view] of nodeViews) {
    const messages = messagesByNode.get(id);
    view.element.classList.toggle("node--error", messages !== undefined);
    if (messages === undefined) {
      clearTooltip(view.element);
    } else {
      const title =
        messages.length === 1
          ? t("graph.compileError")
          : t("graph.compileErrors", { count: messages.length });
      attachTooltip(view.element, title, messages.join("\n"));
    }
  }
}
