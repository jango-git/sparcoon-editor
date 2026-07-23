/**
 * A single scrubbable numeric field (parameters are edited inline on the node). Adapted from the
 * EXAMPLES/ENumberControl reference to the editor's design tokens: flat, sharp-cornered, no
 * transitions or flash animation.
 *
 * A small state machine drives it:
 *   view -> hover (pointer over) -> scrubbing (drag horizontally) -> back
 *   hover -> edit (a click without a drag) -> commit on Enter/blur -> back
 * Increment/decrement chevrons overlay the display and never affect layout. In `compact` mode
 * (vector components, where several controls share one row) the chevrons are dropped and horizontal
 * padding shrinks so the value still reads inside a narrow box.
 *
 * The control is presentational: it emits `onChange` with the committed value and exposes `setValue`
 * the owner uses to re-sync from model state; `setValue` never emits and is ignored while the user
 * is actively scrubbing or editing (so an external redraw can't yank the field out from under the
 * pointer). `value` reads the current number back.
 *
 * `onChange` fires exactly once per gesture - at the true end of a scrub drag, or immediately for a
 * single-shot edit (a chevron click, an Enter/blur text commit) - never per intermediate scrub step,
 * so a caller wiring it to undo history gets one entry per gesture, not one per pixel dragged. The
 * optional `live` fires on every intermediate scrub step instead (never for a single-shot edit,
 * which has no "intermediate"), for a caller that wants a continuous preview without touching
 * history; omitting it means a scrub drag reports nothing until release (the shown number still
 * scrubs smoothly regardless - `refreshDisplay` runs on every step either way).
 */

import { glyphIcons, icon } from "../icons";
import type { ValueComponent } from "../primitives/component";
import { beginPointerDrag } from "../primitives/drag";
import { clamp } from "../primitives/math";

type NumberControlState = "view" | "hover" | "scrubbing" | "edit";

export interface NumberControlOptions {
  readonly value: number;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  /** Value change per pixel of horizontal scrub / per chevron click. */
  readonly step?: number | undefined;
  /** Decimal places kept when formatting the display (trailing zeros trimmed). */
  readonly precision?: number | undefined;
  /** Drops the chevrons and tightens padding for narrow vector-component cells. */
  readonly compact?: boolean | undefined;
  /** Starts muted (grayed, non-interactive) - e.g. a duration field while its infinite toggle is on. */
  readonly disabled?: boolean | undefined;
  /** Fires once, at the end of a gesture (see the class doc) - the history-committing channel. */
  readonly onChange: (value: number) => void;
  /** Fires on every intermediate scrub step (see the class doc) - omit for no live preview at all. */
  readonly live?: ((value: number) => void) | undefined;
}

const SCRUB_THRESHOLD = 3;

export class NumberControl implements ValueComponent<number> {
  public readonly element: HTMLDivElement;

  private readonly display: HTMLSpanElement;
  private readonly input: HTMLInputElement;
  private readonly onChange: (value: number) => void;
  private readonly live: ((value: number) => void) | undefined;

  private currentValue: number;
  private readonly minValue: number;
  private readonly maxValue: number;
  private readonly stepValue: number;
  private readonly precisionValue: number;

  private state: NumberControlState = "view";
  private scrubStartValue = 0;
  /** Cancels an in-flight scrub drag, so `dispose()` can't leave a drag (or the body class) live. */
  private cancelDrag: (() => void) | undefined;
  private disabled = false;

  constructor(options: NumberControlOptions) {
    this.onChange = options.onChange;
    this.live = options.live;
    this.minValue = options.min ?? -Infinity;
    this.maxValue = options.max ?? Infinity;
    this.stepValue = options.step ?? 0.1;
    this.precisionValue = options.precision ?? 3;
    this.currentValue = clamp(options.value, this.minValue, this.maxValue);

    this.element = document.createElement("div");
    this.element.className = "number-control";
    if (options.compact === true) {
      this.element.classList.add("number-control--compact");
    }

    this.display = document.createElement("span");
    this.display.className = "number-control__display";

    this.input = document.createElement("input");
    this.input.className = "number-control__input";
    this.input.type = "text";
    this.input.inputMode = "decimal";

    this.element.append(this.display, this.input);
    if (options.compact !== true) {
      this.element.append(
        this.chevron("decrement", glyphIcons.chevronLeft),
        this.chevron("increment", glyphIcons.chevronRight),
      );
    }

    this.element.addEventListener("mouseenter", this.handleMouseEnter);
    this.element.addEventListener("mouseleave", this.handleMouseLeave);
    this.element.addEventListener("pointerdown", this.handlePointerDown);
    this.input.addEventListener("keydown", this.handleInputKeyDown);
    this.input.addEventListener("blur", this.handleInputBlur);

    this.element.dataset["state"] = "view";
    this.setDisabled(options.disabled ?? false);
    this.refreshDisplay();
  }

  public get value(): number {
    return this.currentValue;
  }

  /** Sets the shown value from model state; never emits, and yields while the user edits. */
  public setValue(next: number): void {
    if (this.state === "scrubbing" || this.state === "edit") {
      return;
    }
    this.currentValue = clamp(next, this.minValue, this.maxValue);
    this.refreshDisplay();
  }

  /** Mutes the field (grayed, non-interactive) or restores it - e.g. a duration held at 0 while its
   * infinite toggle is on. Muting cancels any in-flight scrub/edit and drops back to view. */
  public setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) {
      return;
    }
    this.disabled = disabled;
    this.element.classList.toggle("number-control--disabled", disabled);
    if (disabled) {
      this.cancelDrag?.();
      this.cancelDrag = undefined;
      this.transitionTo("view");
    }
  }

  public dispose(): void {
    this.cancelDrag?.();
    this.cancelDrag = undefined;
    document.body.classList.remove("number-control-scrubbing");
  }

  private chevron(role: "decrement" | "increment", glyph: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = `number-control__${role}`;
    button.append(icon(glyph));
    button.tabIndex = -1;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.disabled) {
        return;
      }
      const delta = role === "increment" ? this.stepValue : -this.stepValue;
      this.applyValue(this.currentValue + delta);
    });
    return button;
  }

  private readonly handleMouseEnter = (): void => {
    if (!this.disabled && this.state === "view") {
      this.transitionTo("hover");
    }
  };

  private readonly handleMouseLeave = (): void => {
    if (this.state === "hover") {
      this.transitionTo("view");
    }
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.state !== "hover") {
      return;
    }
    const target = event.target as Node;
    if (target !== this.element && target !== this.display) {
      return;
    }
    event.preventDefault();
    this.scrubStartValue = this.currentValue;
    // The shared drag helper's threshold is Chebyshev (max of |dx|,|dy|), not the old field's
    // |dx|-only gate - close enough for a horizontal scrubber.
    this.cancelDrag = beginPointerDrag(this.element, event, {
      threshold: SCRUB_THRESHOLD,
      capture: false,
      onDragStart: () => this.transitionTo("scrubbing"),
      onMove: (_moveEvent, { deltaX }) => {
        if (this.state === "scrubbing") {
          this.applyLiveValue(this.scrubStartValue + deltaX * this.stepValue);
        }
      },
      onEnd: (endEvent, dragged) => {
        this.cancelDrag = undefined;
        if (!dragged) {
          this.transitionTo("edit");
          return;
        }
        // One commit for the whole gesture, regardless of how many live steps ran above (or
        // whether `live` was even wired) - the caller's undo history gets exactly one entry.
        if (this.currentValue !== this.scrubStartValue) {
          this.onChange(this.currentValue);
        }
        const under = document.elementFromPoint(endEvent.clientX, endEvent.clientY) ?? undefined;
        this.transitionTo(under !== undefined && this.element.contains(under) ? "hover" : "view");
      },
    });
  };

  private readonly handleInputKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      this.commitEdit();
    } else if (event.key === "Escape") {
      this.transitionTo(this.element.matches(":hover") ? "hover" : "view");
    }
  };

  private readonly handleInputBlur = (): void => {
    if (this.state === "edit") {
      this.commitEdit();
    }
  };

  private transitionTo(next: NumberControlState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.element.dataset["state"] = next;

    if (next === "edit") {
      this.input.value = String(this.currentValue);
      requestAnimationFrame(() => {
        this.input.focus();
        this.input.select();
      });
    }
    document.body.classList.toggle("number-control-scrubbing", next === "scrubbing");
  }

  private commitEdit(): void {
    const parsed = Number.parseFloat(this.input.value);
    if (!Number.isNaN(parsed)) {
      this.applyValue(parsed);
    }
    this.transitionTo(this.element.matches(":hover") ? "hover" : "view");
  }

  private applyValue(value: number): void {
    const clamped = clamp(value, this.minValue, this.maxValue);
    if (clamped === this.currentValue) {
      return;
    }
    this.currentValue = clamped;
    this.refreshDisplay();
    this.onChange(clamped);
  }

  /** Same local update as {@link applyValue}, reported through `live` instead of `onChange` - used
   *  only for an intermediate scrub step, never a single-shot edit (chevron/text commit). */
  private applyLiveValue(value: number): void {
    const clamped = clamp(value, this.minValue, this.maxValue);
    if (clamped === this.currentValue) {
      return;
    }
    this.currentValue = clamped;
    this.refreshDisplay();
    this.live?.(clamped);
  }

  private refreshDisplay(): void {
    this.display.textContent = formatNumber(this.currentValue, this.precisionValue);
  }
}

/** Rounds to `precision` decimals and trims trailing zeros, so `0.5` shows as `0.5` not `0.500`. */
function formatNumber(value: number, precision: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return String(Number(value.toFixed(precision)));
}
