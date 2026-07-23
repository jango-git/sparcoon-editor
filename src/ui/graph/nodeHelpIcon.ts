import { createElement } from "../dom";
import { attachTooltip } from "../components/tooltip";

/**
 * A node header's help "?" (inline SVG) that shows the node's documentation in the shared hover
 * tooltip (node label over its description) - the same tooltip used everywhere. Swallows
 * pointerdown so clicking it never drags/selects the node.
 */
export function buildHelpIcon(title: string, description: string): HTMLElement {
  const svgNamespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const parts = [
    ["rect", { x: "2", y: "2", width: "20", height: "20" }],
    ["path", { d: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" }],
    ["path", { d: "M12 17h.01" }],
  ] as const;
  for (const [tag, attributes] of parts) {
    const node = document.createElementNS(svgNamespace, tag);
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, value);
    }
    svg.append(node);
  }
  const icon = createElement("span", { className: "node__help" });
  icon.append(svg);
  icon.addEventListener("pointerdown", (event) => event.stopPropagation());
  attachTooltip(icon, title, description);
  return icon;
}
