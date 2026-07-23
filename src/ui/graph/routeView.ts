/**
 * A route (reroute knot) rendered as a tiny headerless card: just an input dot and an output dot
 * on two adjacent grid cells (a la Unreal Blueprints knots). A route carries no logic - it only
 * tidies wire layout - so it has no title, params or body, and the compiler never sees it
 * ({@link serializeGraph} splices it out).
 *
 * It mirrors {@link NodeView}'s socket-dot markup (the same `.socket__dot` element with the same
 * `data-*` attributes) so the canvas can start a wire from it, hit-test a drop on it via
 * `elementFromPoint`, and measure its endpoints - a route behaves like any other node for wiring,
 * dragging, selection and reconciliation (it lives in `graph.nodes`).
 */

import { createElement } from "../dom";
import { GRID_SIZE } from "./grid";
import { socketTypeColor } from "./socketColors";
import { ROUTE_INPUT_KEY, ROUTE_OUTPUT_KEY } from "../../domain/fakeNodes";
import type { SocketPointerHandler, SocketRef, SocketSide } from "./nodeView";

export class RouteView {
  public readonly element: HTMLElement;
  private readonly dots = new Map<string, HTMLElement>();

  constructor(nodeId: string, onSocketPointerDown?: SocketPointerHandler) {
    const input = this.buildDot(nodeId, ROUTE_INPUT_KEY, "input", onSocketPointerDown);
    const output = this.buildDot(nodeId, ROUTE_OUTPUT_KEY, "output", onSocketPointerDown);
    // Three grid cells wide, one tall: the input dot hugs the left edge, the output the right,
    // and the roomy middle is an easy drag target that never lands on a pin.
    this.element = createElement("div", { className: "node node--route" }, [input, output]);
    this.element.style.width = `${GRID_SIZE * 3}px`;
    this.element.style.height = `${GRID_SIZE}px`;
  }

  public setPosition(x: number, y: number): void {
    this.element.style.transform = `translate(${x}px, ${y}px)`;
  }

  public socketDot(side: SocketSide, key: string): HTMLElement | undefined {
    return this.dots.get(`${side}:${key}`);
  }

  /** Paints both dots filled when connected (a route's ports almost always carry an edge). */
  public applySocketFills(filledKeys: ReadonlySet<string>): void {
    for (const [key, dot] of this.dots) {
      dot.classList.toggle("socket__dot--filled", filledKeys.has(key));
    }
  }

  /** Recolors both dots to the type flowing through the route (grey `T` when unknown). */
  public applyType(type: string): void {
    const color = socketTypeColor(type);
    for (const dot of this.dots.values()) {
      dot.style.setProperty("--socket-color", color);
    }
  }

  public setSelected(selected: boolean): void {
    this.element.classList.toggle("node--selected", selected);
  }

  private buildDot(
    nodeId: string,
    key: string,
    side: SocketSide,
    onSocketPointerDown?: SocketPointerHandler,
  ): HTMLElement {
    const dot = createElement("span", { className: `socket__dot socket__dot--${side}` });
    // Route ports are generic: they accept and pass through any type, so their carried type is
    // `"T"` for drop-compatibility while {@link applyType} tints them by what actually flows.
    const ref: SocketRef = { nodeId, socketKey: key, side, type: "T" };
    dot.dataset["node"] = nodeId;
    dot.dataset["socket"] = key;
    dot.dataset["side"] = side;
    dot.dataset["type"] = "T";
    if (onSocketPointerDown !== undefined) {
      dot.addEventListener("pointerdown", (event) => onSocketPointerDown(event, ref));
    }
    this.dots.set(`${side}:${key}`, dot);
    return dot;
  }
}
