/**
 * Parses an SVG string into a new `<svg>` node on each call. Icons use a 16x16 viewBox and
 * `currentColor`.
 */
export function icon(svg: string): SVGElement {
  const template = document.createElement("template");
  template.innerHTML = svg.trim();
  const node = template.content.firstElementChild;
  if (!(node instanceof SVGElement)) {
    throw new Error("icon(): expected an <svg> string");
  }
  return node;
}
