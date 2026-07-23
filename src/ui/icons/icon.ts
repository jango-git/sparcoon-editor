/**
 * Inline-SVG icon helper. Icons are hand-written SVG strings grouped by category in the sibling
 * modules: a 16x16 viewBox, `stroke`/`fill` set to `currentColor` so the glyph inherits its
 * button's text color, and no hard-coded colors.
 *
 * `icon()` parses one such string into a fresh live <svg> node; each call returns a new node, so
 * the same icon string can back several buttons.
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
