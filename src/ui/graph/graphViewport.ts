/**
 * Screen <-> graph coordinate transform for the node canvas: pan + zoom applied as a single CSS
 * transform on the content layer. Node elements are positioned in graph coordinates; this layer
 * maps them to the screen.
 */

import { clamp } from "../primitives/math";
import { GRID_SIZE } from "./grid";

export interface GraphPoint {
  readonly x: number;
  readonly y: number;
}

/** A saved pan/zoom, so each graph can keep its own camera (see {@link GraphViewport.getState}). */
export interface CameraState {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
}

/** A rectangle in graph coordinates, used to frame a region of the graph. */
export interface GraphRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const MINIMUM_ZOOM = 0.2;
const MAXIMUM_ZOOM = 3;

/** Padding (screen px) kept around a framed region so it never touches the canvas edges. */
const FRAME_PADDING = 56;

export class GraphViewport {
  private panX = 0;
  private panY = 0;
  private zoom = 1;

  /**
   * @param content - the transformed node layer
   * @param surface - the element carrying the dotted grid background, kept in sync
   *   with pan/zoom so the grid lines up with snapped nodes
   */
  constructor(
    private readonly content: HTMLElement,
    private readonly surface: HTMLElement,
  ) {
    this.applyTransform();
  }

  public get scale(): number {
    return this.zoom;
  }

  /** The current pan/zoom, to stash when leaving a graph. */
  public getState(): CameraState {
    return { panX: this.panX, panY: this.panY, zoom: this.zoom };
  }

  /** Restores a previously stashed pan/zoom (when returning to a graph). */
  public setState(state: CameraState): void {
    this.panX = state.panX;
    this.panY = state.panY;
    this.zoom = state.zoom;
    this.applyTransform();
  }

  /** Resets to the identity camera (origin, 1x zoom) - a never-visited graph's default. */
  public reset(): void {
    this.setState({ panX: 0, panY: 0, zoom: 1 });
  }

  /**
   * Frames a graph-space rectangle: centres it in the canvas and zooms so it fits with padding,
   * as large as the zoom limits allow. A zero-area rectangle (a single node) frames at 1x zoom.
   */
  public frameRect(rectangle: GraphRect, bounds: DOMRect): void {
    const width = rectangle.maxX - rectangle.minX;
    const height = rectangle.maxY - rectangle.minY;
    const availableWidth = Math.max(1, bounds.width - 2 * FRAME_PADDING);
    const availableHeight = Math.max(1, bounds.height - 2 * FRAME_PADDING);
    let zoom = 1;
    if (width > 0 && height > 0) {
      zoom = Math.min(availableWidth / width, availableHeight / height);
    } else if (width > 0) {
      zoom = availableWidth / width;
    } else if (height > 0) {
      zoom = availableHeight / height;
    }
    this.zoom = clamp(zoom, MINIMUM_ZOOM, MAXIMUM_ZOOM);
    // Place the rectangle's centre at the canvas centre (pan is measured from the canvas origin).
    const centreX = (rectangle.minX + rectangle.maxX) / 2;
    const centreY = (rectangle.minY + rectangle.maxY) / 2;
    this.panX = bounds.width / 2 - centreX * this.zoom;
    this.panY = bounds.height / 2 - centreY * this.zoom;
    this.applyTransform();
  }

  /** Converts a client point to graph coordinates, given the canvas bounds. */
  public screenToGraph(clientX: number, clientY: number, bounds: DOMRect): GraphPoint {
    return {
      x: (clientX - bounds.left - this.panX) / this.zoom,
      y: (clientY - bounds.top - this.panY) / this.zoom,
    };
  }

  public panBy(deltaScreenX: number, deltaScreenY: number): void {
    this.panX += deltaScreenX;
    this.panY += deltaScreenY;
    this.applyTransform();
  }

  /** Zooms by `factor`, keeping the graph point under the cursor fixed on screen. */
  public zoomAt(clientX: number, clientY: number, bounds: DOMRect, factor: number): void {
    const anchor = this.screenToGraph(clientX, clientY, bounds);
    this.zoom = clamp(this.zoom * factor, MINIMUM_ZOOM, MAXIMUM_ZOOM);
    this.panX = clientX - bounds.left - anchor.x * this.zoom;
    this.panY = clientY - bounds.top - anchor.y * this.zoom;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.content.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    const cell = GRID_SIZE * this.zoom;
    this.surface.style.backgroundSize = `${cell}px ${cell}px`;
    // Offset the dots by half a cell so each sits in the centre of a grid square
    // (node corners land on the grid lines, the dots on the cells between them).
    this.surface.style.backgroundPosition = `${this.panX + cell / 2}px ${this.panY + cell / 2}px`;
  }
}
