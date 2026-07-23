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
 * repositions the overlays that live outside the scroller: the caret, the gray margin gutters, the
 * frame-tick spacing published to CSS, and the seconds ruler docked above the grid (with the
 * caret's own current-frame flag pinned to it).
 *
 * View state is transient editor focus (like the transport), never persisted.
 */

import { t } from "../../i18n";
import { frameOf } from "../../model/frames";
import { createElement } from "../dom";
import { beginPointerDrag } from "../primitives/drag";
import { fractionAcross } from "../primitives/geometry";
import { clamp } from "../primitives/math";
import { fraction, rangeSpan, timeAtFraction, trimNumber } from "./timelineFormat";

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
/** Smallest gap (px) between labelled ruler ticks - wider than a bare gridline needs, so the text
 *  never crowds. */
const RULER_LABEL_MIN_PX = 40;

/** The 1-2-5 "nice" ladder, so tick density steps logarithmically with zoom - shared by the lane's
 *  frame-tick spacing (whole frames only) and the ruler's second-tick spacing (fractional seconds
 *  allowed), which differ in unit and in how far the ladder is let to shrink. */
const TICK_STEPS = [1, 2, 5];

/**
 * The smallest nice step (from the 1-2-5 ladder, scaled by powers of ten) that is at least
 * `minValue`. `minDecade` floors how far the ladder's own power-of-ten base may shrink - 1 for the
 * lane's frame ticks (fractional frames don't exist), 0 (unbounded) for the ruler's second ticks,
 * which instead clamp the returned value to one frame's duration afterward - a floor that isn't
 * itself a power of ten doesn't fit this parameter.
 */
function niceStep(minValue: number, minDecade = 1): number {
  const largestTickStep = Math.max(...TICK_STEPS);
  const decade = Math.max(minDecade, 10 ** Math.floor(Math.log10(minValue / largestTickStep)));
  for (let candidateDecade = decade; ; candidateDecade *= 10) {
    for (const step of TICK_STEPS) {
      const value = step * candidateDecade;
      if (value >= minValue) {
        return value;
      }
    }
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
  /** The playhead's raw time (seconds) - the ruler flag's frame number. */
  readonly currentTime: () => number;
  /** Whether an infinite play event is active - the flag matches the caret's own colour swap. */
  readonly isInfinite: () => boolean;
}

export class TimelineViewport {
  /** The bottom scrollbar element to mount under the grid. */
  public readonly element: HTMLElement;
  /** The seconds ruler to mount above the grid. */
  public readonly rulerElement: HTMLElement;
  /** The current-frame flag (Blender-style), pinned over the caret's x on the ruler - draggable
   *  like the caret itself (wired by the panel, which owns the scrub gesture). */
  public readonly flag: HTMLElement;
  /** The ruler's tick-bearing zone, flexed between its fixed-width label/inspector spacers so
   *  absolutely-positioned children (ticks, the flag) share the lanes' own coordinate space. A
   *  press anywhere on it also scrubs, like the flag (wired by the panel alongside the flag's own
   *  listener, which owns the scrub gesture). */
  public readonly rulerLane: HTMLElement;
  private readonly thumb: HTMLElement;
  private readonly track: HTMLElement;
  /** Translucent gray washes over the padded margins before frame 0 and past the end. */
  private readonly gutterBefore: HTMLElement;
  private readonly gutterAfter: HTMLElement;
  /** Ticks are rebuilt every repaint (their count/spacing changes with zoom); tracked separately
   *  from the flag so a rebuild never has to recreate or re-measure that persistent element. */
  private rulerTicks: HTMLElement[] = [];
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

    // Flanking spacers sized to the label/inspector columns; the lane between them gets its own
    // (darker) fill so the strip reads as three columns, not one (colours defined in timeline.css).
    const rulerLabels = createElement("div", { className: "timeline__ruler-labels" });
    const rulerInspector = createElement("div", { className: "timeline__ruler-inspector" });
    this.rulerLane = createElement("div", { className: "timeline__ruler-lane" });
    this.flag = createElement("div", { className: "timeline__ruler-flag" });
    this.rulerLane.append(this.flag);
    this.rulerElement = createElement("div", { className: "timeline__ruler" }, [
      rulerLabels,
      this.rulerLane,
      rulerInspector,
    ]);

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

  /** Repositions the caret overlay and its ruler flag for the current progress + scroll (called on
   *  every transport tick). */
  public positionPlayhead(): void {
    const lane = this.laneWidth();
    if (lane === 0) {
      this.config.playhead.hidden = true;
      this.flag.hidden = true;
      return;
    }
    const visibleX = this.config.progress() * lane - this.config.scroll.scrollLeft;
    if (visibleX < -0.5 || visibleX > this.viewportLaneWidth() + 0.5) {
      // The caret's time lies outside the zoomed-in window - drop it rather than draw it on the labels.
      this.config.playhead.hidden = true;
      this.flag.hidden = true;
      return;
    }
    this.config.playhead.hidden = false;
    this.config.playhead.style.left = `${this.labelWidth() + visibleX}px`;
    this.flag.hidden = false;
    // The flag lives inside `rulerLane`, a flex sibling of the label spacer (see its CSS) - unlike
    // the caret above, its `left` needs no separate label-width offset.
    this.flag.style.left = `${visibleX}px`;
    this.flag.textContent = String(frameOf(this.config.currentTime(), this.config.fps()));
    // Matches the caret's own colour swap while an infinite play event runs.
    this.flag.classList.toggle("timeline__ruler-flag--infinite", this.config.isInfinite());
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
    this.updateRuler();
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
    const minorFrames = niceStep(MINOR_TICK_MIN_PX / framePx);
    const minorPx = minorFrames * framePx;
    const style = this.config.rows.style;
    style.setProperty("--timeline-tick-px", `${minorPx}px`);
    style.setProperty("--timeline-major-px", `${minorPx * MAJOR_TICK_EVERY}px`);
    style.setProperty("--timeline-tick-offset", `${fraction(0, total) * lane}px`);
  }

  /**
   * Rebuilds the ruler's labelled ticks for the current zoom/scroll: always seconds and fractions
   * of a second (the flag beside it names the frame instead - see positionPlayhead), on the same
   * "nice" 1-2-5 ladder {@link updateTicks} steps the lane's own frame gridlines with, just in a
   * continuous unit - so zooming in refines the label down through tenths, hundredths, thousandths
   * of a second instead of switching units. Floored at one frame's duration regardless of how far
   * the nice-step ladder itself would shrink: a finer step would label positions the caret can
   * never actually land on (it always snaps to the frame grid). Ticks are plain children of
   * `rulerLane`, tracked separately from the persistent flag so only they get torn down each
   * repaint.
   */
  private updateRuler(): void {
    for (const tick of this.rulerTicks) {
      tick.remove();
    }
    this.rulerTicks = [];
    const lane = this.laneWidth();
    const total = this.config.duration();
    const fps = this.config.fps();
    if (lane <= 0 || total <= 0 || fps <= 0) {
      return;
    }
    const pixelsPerSecond = lane / rangeSpan(total);
    const secondsPerTick = Math.max(niceStep(RULER_LABEL_MIN_PX / pixelsPerSecond, 0), 1 / fps);
    const scroll = this.config.scroll.scrollLeft;
    const viewportLane = this.viewportLaneWidth();
    const startTime = timeAtFraction(scroll / lane, total);
    const endTime = timeAtFraction((scroll + viewportLane) / lane, total);
    const firstSeconds = Math.ceil(startTime / secondsPerTick) * secondsPerTick;
    for (let index = 0; ; index++) {
      const seconds = firstSeconds + index * secondsPerTick;
      if (seconds > endTime) {
        break;
      }
      this.addRulerTick(
        fraction(seconds, total) * lane - scroll,
        `${trimNumber(seconds)}${t("transport.unitSeconds")}`,
      );
    }
  }

  /** Appends one labelled tick to `rulerLane` at pixel offset `x`. */
  private addRulerTick(x: number, text: string): void {
    const label = createElement("span", {
      className: "timeline__ruler-tick-label",
      textContent: text,
    });
    const tick = createElement("div", { className: "timeline__ruler-tick" }, [label]);
    tick.style.left = `${x}px`;
    this.rulerLane.append(tick);
    this.rulerTicks.push(tick);
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
