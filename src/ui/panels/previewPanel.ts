/**
 * Preview region: the live 3D viewport. Owns only the canvas element - the render layer attaches
 * the WebGL renderer to it. The dotted stage-grid CSS on `.preview` is a fallback background;
 * the opaque canvas covers it once the renderer starts drawing.
 */

import { createElement } from "../dom";

export interface PreviewPanel {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
}

export function createPreviewPanel(): PreviewPanel {
  const canvas = createElement("canvas", { className: "preview__canvas" });
  const element = createElement("div", { className: "preview" }, [canvas]);
  return { element, canvas };
}
