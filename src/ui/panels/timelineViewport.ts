/**
 * Horizontal zoom + pan for the timeline lanes, plus the Blender-style bottom scrollbar that drives
 * them. The lane covers a padded range (a margin of negative time before frame 0 and past the end,
 * see timelineFormat), so the user can scroll a little before 0 and the rows continue past the
 * authored length. Zoom is a fraction `span` of that range (span = 1 fills the viewport, the max
 * zoom-out; smaller spans zoom in), offset by a `viewStart`.
 *
 * It is realized purely by scaling the lane content: `--timeline-zoom` on `.timeline__rows` makes
 * each lane `zoom x` the viewport width (the label column stays fixed via sticky CSS), and
 * `scrollLeft` picks the visible slice. Because every marker/scrub/drag maps pointer-X through a
 * lane's live `getBoundingClientRect()`, they keep working under zoom with no change. This class
 * repositions the overlays that live outside the scroller: the caret, the gray margin gutters, and
 * the frame-tick spacing published to CSS.
 *
 * View state is transient editor focus (like the transport), never persisted.
 */

import { createElement } from "../dom";
import { beginPointerDrag } from "../primitives/drag";
import { fractionAcross } from "../primitives/geometry";
import { clamp } from "../primitives/math";
import { fraction, rangeSpan } from "./timelineFormat";

/** The visible window never shrinks below this fraction of the padded range (the max horizontal zoom). */
const MIN_SPAN = 0.02;
/** Zooming out stops once the whole padded range fills the viewport; there is nothing further to show. */
const MAX_SPAN = 1;
/** Per wheel-notch zoom factor (ctrl/cmd + wheel). */
const ZOOM_STEP = 1.2;
/** Fraction of the duration left as breathing room on each side of the F hotkey's framed view. */
const FIT_MARGIN = 0.05;
/** Smallest gap (px) between minor frame ticks; the tick interval steps up (1-2-5 frames) to keep it. */
const MINOR_TICK_MIN_PX = 9;
/** Every Nth minor tick is a brighter major line (Blender-style major/minor rhythm). */
const MAJOR_TICK_EVERY = 5;

/** The 1-2-5 "nice" ladder of frames-per-tick, so tick density steps logarithmically with zoom. */
const TICK_STEPS = [1, 2, 5];

/** The smallest nice frames-per-tick that is at least `minFrames` (never finer than one frame). */
function niceTickFrames(minFrames: number): number {
  let decade = 1;
  for (;;) {
    for (const step of TICK_STEPS) {
      const frames = step * decade;
      if (frames >= minFrames) {
        return frames;
      }
    }
    decade *= 10;
  }
}

export interface TimelineViewportConfig {
  /** The horizontally-scrolling lane container (`.timeline__scroll`). */
  readonly scroll: HTMLElement;
  /** Carries `--timeline-zoom`; its lanes scale with it (`.timeline__rows`). */
  readonly rows: HTMLElement;
  /** The caret overlay, positioned in pixels over the visible window (`.timeline__playhead`). */
  readonly playhead: HTMLElement;
  /** The wheel-zoom surface and the playhead's offset parent (`.timeline__stage`). */
  readonly stage: HTMLElement;
  /** The authored timeline length (seconds); drives the padded range, gutters and frame ticks. */
  readonly duration: () => number;
  /** The frame rate; the tick interval never falls below one frame at the current zoom. */
  readonly fps: () => number;
  /** The caret's position as a fraction [0, 1] across the padded lane. */
  readonly progress: () => number;
}

export class TimelineViewport {
  /** The bottom scrollbar element to mount under the grid. */
  public readonly element: HTMLElement;
  private readonly thumb: HTMLElement;
  private readonly track: HTMLElement;
  /** Translucent gray washes over the padded margins before frame 0 and past the end. */
  private readonly gutterBefore: HTMLElement;
  private readonly gutterAfter: HTMLElement;
  /** Visible fraction of the padded range; zoom = 1 / span. */
  private span = 1;

  constructor(private readonly config: TimelineViewportConfig) {
    this.track = createElement("div", { className: "timeline__scrollbar-track" });
    this.thumb = createElement("div", { className: "timeline__scrollbar-thumb" });
    const leftHandle = createElement("div", {
      className: "timeline__scrollbar-handle timeline__scrollbar-handle--left",
    });
    const rightHandle = createElement("div", {
      className: "timeline__scrollbar-handle timeline__scrollbar-handle--right",
    });
    this.thumb.append(leftHandle, rightHandle);
    this.track.append(this.thumb);
    this.element = createElement("div", { className: "timeline__scrollbar" }, [this.track]);

    this.gutterBefore = createElement("div", {
      className: "timeline__gutter timeline__gutter--before",
    });
    this.gutterAfter = createElement("div", {
      className: "timeline__gutter timeline__gutter--after",
    });
    this.gutterBefore.hidden = true;
    this.gutterAfter.hidden = true;
    this.config.stage.append(this.gutterBefore, this.gutterAfter);

    this.thumb.addEventListener("pointerdown", (down) => this.beginThumbDrag(down));
    leftHandle.addEventListener("pointerdown", (down) => this.beginHandleDrag(down, "left"));
    rightHandle.addEventListener("pointerdown", (down) => this.beginHandleDrag(down, "right"));
    // A press on the empty track pages the window so it centres on the click.
    this.track.addEventListener("pointerdown", (down) => {
      if (down.target !== this.track || down.button !== 0) {
        return;
      }
      const focus = fractionAcross(down.clientX, this.track.getBoundingClientRect());
      this.setScroll(focus - this.span / 2);
    });

    this.config.stage.addEventListener("wheel", this.onWheel, { passive: false });
    // Trackpad / native scroll keeps the custom thumb + caret in step.
    this.config.scroll.addEventListener("scroll", this.onScroll);
    // The first render()/refresh() runs before the panel is in the DOM, so the lane measures 0 and
    // the tick + gutter paint is skipped until something repaints it. Observing the scroller repaints
    // once it is laid out (fixing the missing gridlines/borders before the first scroll) and on every
    // panel resize (the bottom-band divider drag, which no window `resize` fires for).
    new ResizeObserver(() => this.refresh()).observe(this.config.scroll);
  }

  /** Re-applies the zoom var and repaints the thumb + caret + dim (after a row rebuild or a resize). */
  public refresh(): void {
    this.applyZoom();
    this.clampScroll();
    this.paint();
  }

  /** Repositions the caret overlay for the current progress + scroll (called on every transport tick). */
  public positionPlayhead(): void {
    const lane = this.laneWidth();
    if (lane === 0) {
      this.config.playhead.hidden = true;
      return;
    }
    const visibleX = this.config.progress() * lane - this.config.scroll.scrollLeft;
    if (visibleX < -0.5 || visibleX > this.viewportLaneWidth() + 0.5) {
      // The caret's time lies outside the zoomed-in window - drop it rather than draw it on the labels.
      this.config.playhead.hidden = true;
      return;
    }
    this.config.playhead.hidden = false;
    this.config.playhead.style.left = `${this.labelWidth() + visibleX}px`;
  }

  /** Frames the authored timeline [0, duration] (the F hotkey), with a small margin on each edge
   * rather than flush against the viewport - Blender-style "view all", not "view exact". */
  public fitTimeline(): void {
    const total = this.config.duration();
    const margin = total * FIT_MARGIN;
    this.setWindow(fraction(-margin, total), fraction(total + margin, total));
  }

  /** Pans by a pixel delta (RMB-drag "grab": dragging right reveals earlier time). No-op zoomed out. */
  public panByPixels(deltaX: number): void {
    const max = Math.max(0, this.laneWidth() - this.viewportLaneWidth());
    this.config.scroll.scrollLeft = clamp(this.config.scroll.scrollLeft - deltaX, 0, max);
    this.paint();
  }

  private paint(): void {
    this.updateThumb();
    this.positionPlayhead();
    this.updateGutters();
    this.updateTicks();
  }

  private applyZoom(): void {
    this.config.rows.style.setProperty("--timeline-zoom", String(1 / this.span));
  }

  /** The rendered width of one (scaled) lane; 0 before any row exists. */
  private laneWidth(): number {
    const lane = this.config.rows.querySelector<HTMLElement>(".timeline-row__lane");
    return lane?.getBoundingClientRect().width ?? 0;
  }

  private labelWidth(): number {
    const label = this.config.rows.querySelector<HTMLElement>(".timeline-row__label");
    return label?.getBoundingClientRect().width ?? 0;
  }

  /** The visible slice of a lane (the viewport minus the fixed label column). */
  private viewportLaneWidth(): number {
    return Math.max(0, this.config.scroll.clientWidth - this.labelWidth());
  }

  /** The largest the window's left edge can be (0 once the timeline no longer overflows). */
  private maxViewStart(): number {
    return Math.max(0, 1 - this.span);
  }

  /** The window's left edge as a fraction of the timeline, derived from the live scroll offset. */
  private viewStart(): number {
    const lane = this.laneWidth();
    return lane > 0 ? clamp(this.config.scroll.scrollLeft / lane, 0, this.maxViewStart()) : 0;
  }

  private clampScroll(): void {
    const max = Math.max(0, this.laneWidth() - this.viewportLaneWidth());
    this.config.scroll.scrollLeft = clamp(this.config.scroll.scrollLeft, 0, max);
  }

  /** Sets the window's left edge (clamped) from a target start fraction. */
  private setScroll(start: number): void {
    this.config.scroll.scrollLeft = clamp(start, 0, this.maxViewStart()) * this.laneWidth();
    this.paint();
  }

  private updateThumb(): void {
    // At full zoom-out (span = 1) the whole padded range is visible, so the pill fills the track.
    const displaySpan = Math.min(this.span, 1);
    this.thumb.style.left = `${clamp(this.viewStart(), 0, 1 - displaySpan) * 100}%`;
    this.thumb.style.width = `${displaySpan * 100}%`;
  }

  /**
   * Grays the padded margins that fall inside the view: the strip before frame 0 and the strip past
   * the authored end. Both are translucent washes over the lanes, so the per-row zebra
   * still reads through them; they are positioned in the same visible-X space as the caret.
   */
  private updateGutters(): void {
    const lane = this.laneWidth();
    const total = this.config.duration();
    if (lane <= 0 || total <= 0) {
      this.gutterBefore.hidden = true;
      this.gutterAfter.hidden = true;
      return;
    }
    const viewportLane = this.viewportLaneWidth();
    const label = this.labelWidth();
    const scroll = this.config.scroll.scrollLeft;
    const startX = clamp(fraction(0, total) * lane - scroll, 0, viewportLane);
    const endX = clamp(fraction(total, total) * lane - scroll, 0, viewportLane);
    this.placeGutter(this.gutterBefore, label, startX);
    this.placeGutter(this.gutterAfter, label + endX, viewportLane - endX);
  }

  private placeGutter(gutter: HTMLElement, left: number, width: number): void {
    if (width <= 0.5) {
      gutter.hidden = true;
      return;
    }
    gutter.hidden = false;
    gutter.style.left = `${left}px`;
    gutter.style.width = `${width}px`;
  }

  /**
   * Publishes the frame-tick spacing to CSS: the lanes paint vertical gridlines sized by
   * `--timeline-tick-px` / `--timeline-major-px`. The interval steps 1-2-5 frames with zoom so ticks
   * stay legible, never finer than one frame, aligned to frame 0 by `--timeline-tick-offset`.
   */
  private updateTicks(): void {
    const lane = this.laneWidth();
    const total = this.config.duration();
    const fps = this.config.fps();
    if (lane <= 0 || total <= 0 || fps <= 0) {
      return;
    }
    const framePx = lane / rangeSpan(total) / fps;
    const minorFrames = niceTickFrames(MINOR_TICK_MIN_PX / framePx);
    const minorPx = minorFrames * framePx;
    const style = this.config.rows.style;
    style.setProperty("--timeline-tick-px", `${minorPx}px`);
    style.setProperty("--timeline-major-px", `${minorPx * MAJOR_TICK_EVERY}px`);
    style.setProperty("--timeline-tick-offset", `${fraction(0, total) * lane}px`);
  }

  /** Zooms to `newSpan`, keeping the timeline fraction `focus` pinned to its current screen spot. */
  private zoomTo(newSpan: number, focus: number): void {
    const clampedSpan = clamp(newSpan, MIN_SPAN, MAX_SPAN);
    const startFraction = this.viewStart();
    const screen = this.span > 0 ? (focus - startFraction) / this.span : 0;
    this.span = clampedSpan;
    this.applyZoom();
    this.setScroll(focus - screen * clampedSpan);
  }

  /** Sets the window to `[start, end]` (fractions), re-deriving the span, and scrolls to it. */
  private setWindow(start: number, end: number): void {
    this.span = clamp(end - start, MIN_SPAN, MAX_SPAN);
    this.applyZoom();
    this.setScroll(start);
  }

  private beginThumbDrag(down: PointerEvent): void {
    if (down.button !== 0) {
      return;
    }
    down.preventDefault();
    down.stopPropagation();
    const trackWidth = this.track.getBoundingClientRect().width;
    const startFraction = this.viewStart();
    beginPointerDrag(this.track, down, {
      capture: false,
      onMove: (_move, delta) => {
        if (trackWidth > 0) {
          this.setScroll(startFraction + delta.deltaX / trackWidth);
        }
      },
    });
  }

  /** Dragging a thumb edge resizes the window (zoom) with the opposite edge pinned. */
  private beginHandleDrag(down: PointerEvent, side: "left" | "right"): void {
    if (down.button !== 0) {
      return;
    }
    down.preventDefault();
    down.stopPropagation();
    const trackWidth = this.track.getBoundingClientRect().width;
    const startStart = this.viewStart();
    const startEnd = startStart + Math.min(this.span, 1);
    beginPointerDrag(this.track, down, {
      capture: false,
      onMove: (_move, delta) => {
        if (trackWidth === 0) {
          return;
        }
        const deltaFraction = delta.deltaX / trackWidth;
        if (side === "right") {
          this.setWindow(startStart, clamp(startEnd + deltaFraction, startStart + MIN_SPAN, 1));
        } else {
          this.setWindow(clamp(startStart + deltaFraction, 0, startEnd - MIN_SPAN), startEnd);
        }
      },
    });
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const lane = this.config.rows.querySelector<HTMLElement>(".timeline-row__lane");
      if (lane) {
        const focus = fractionAcross(event.clientX, lane.getBoundingClientRect());
        this.zoomTo(this.span * (event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP), focus);
      }
      return;
    }
    // Horizontal intent (trackpad swipe, or shift+wheel) pans; a plain wheel scrolls rows natively.
    const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
    const lane = this.laneWidth();
    if (horizontal !== 0 && lane > 0) {
      event.preventDefault();
      this.setScroll(this.viewStart() + horizontal / lane);
    }
  };

  private readonly onScroll = (): void => {
    this.paint();
  };
}
