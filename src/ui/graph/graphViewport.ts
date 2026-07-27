/**
 * Screen <-> graph coordinate transform for the node canvas. The viewport owns one camera
 * (pan + zoom) and broadcasts it to every {@link CameraTarget} it was built with - each surface
 * applies the same camera in its own idiom (a CSS transform, an SVG group transform, a background
 * offset). Nothing inherits the camera by DOM nesting, so a layer's stacking order and its
 * coordinate system stay independent choices.
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

/** One surface the camera drives, given the camera in screen pixels (pan) and scale (zoom). */
export interface CameraTarget {
  applyCamera(panX: number, panY: number, zoom: number): void;
}

/** An absolutely-positioned HTML layer whose children are placed in graph coordinates. */
export function htmlLayerTarget(layer: HTMLElement): CameraTarget {
  return {
    applyCamera(panX: number, panY: number, zoom: number): void {
      layer.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    },
  };
}

/** A group inside a screen-space SVG surface whose geometry is authored in graph coordinates. */
export function svgGroupTarget(group: SVGGElement): CameraTarget {
  return {
    applyCamera(panX: number, panY: number, zoom: number): void {
      group.setAttribute("transform", `translate(${panX} ${panY}) scale(${zoom})`);
    },
  };
}

/** The dotted grid, painted as a repeating background image on the canvas surface itself. */
export function dottedGridTarget(surface: HTMLElement): CameraTarget {
  return {
    applyCamera(panX: number, panY: number, zoom: number): void {
      const cell = GRID_SIZE * zoom;
      surface.style.backgroundSize = `${cell}px ${cell}px`;
      // Offset the dots by half a cell so each sits in the centre of a grid square
      // (node corners land on the grid lines, the dots on the cells between them).
      surface.style.backgroundPosition = `${panX + cell / 2}px ${panY + cell / 2}px`;
    },
  };
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
   * @param targets - every surface the camera drives, in no particular order (see
   *   {@link htmlLayerTarget}, {@link svgGroupTarget}, {@link dottedGridTarget})
   */
  constructor(private readonly targets: readonly CameraTarget[]) {
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
    for (const target of this.targets) {
      target.applyCamera(this.panX, this.panY, this.zoom);
    }
  }
}
