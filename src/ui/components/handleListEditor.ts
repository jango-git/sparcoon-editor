/**
 * The shared spine of the ramp and curve editors: a selectable list of draggable handles that emits
 * its value live and re-syncs from external state without echoing its own edit. The two are
 * otherwise different widgets - a 1D color bar (CSS gradient) versus a 2D scalar curve (SVG) - so
 * this base owns ONLY the selection + emit + teardown state machine. Every subclass supplies its own
 * item model, preview, handle DOM, drag motion and inline editor through the abstract hooks below.
 */

import type { ValueComponent } from "../primitives/component";
import { beginPointerDrag } from "../primitives/drag";

export abstract class HandleListEditor<TItem, TValue> implements ValueComponent<TValue> {
  /** The editable items, in author order (a ramp's stops / a curve's anchors). */
  protected items: TItem[] = [];
  /** Index of the selected item, whose inline editor is shown. */
  protected selected = 0;

  /** Set while emitting, so the re-render an edit triggers doesn't echo back through setValue. */
  private suppressSync = false;
  /** Cancels the live handle drag, so dispose() can't leave window listeners live. */
  private activeDrag: (() => void) | undefined;

  public abstract readonly element: HTMLElement;

  protected constructor(
    private readonly onChange: (value: TValue) => void,
    /** Fires on every intermediate drag step (see {@link emit}); omit for no live preview at all. */
    private readonly onLive?: (value: TValue) => void,
  ) {}

  /** The element holding the handle nodes in item order, for the selected-class toggle. */
  protected abstract get handleContainer(): HTMLElement;
  /** The CSS class marking the selected handle. */
  protected abstract get selectedHandleClass(): string;

  /** Re-syncs the shown items from external state (undo / redo) without firing `onChange`. */
  public setValue(value: TValue): void {
    if (this.suppressSync) {
      return;
    }
    this.items = this.normalize(value);
    this.selected = Math.min(this.selected, this.items.length - 1);
    this.render();
  }

  public dispose(): void {
    this.activeDrag?.();
    this.activeDrag = undefined;
    this.disposeParts();
  }

  /**
   * Reports the serialized value, guarding against the synchronous re-sync echo. `final` (the
   * default) fires the committing `onChange`; `final: false` fires `onLive` instead, for an
   * intermediate drag step in progress (see {@link attachHandleDrag}).
   */
  protected emit(final = true): void {
    this.suppressSync = true;
    if (final) {
      this.onChange(this.serialize());
    } else {
      this.onLive?.(this.serialize());
    }
    this.suppressSync = false;
  }

  /** Removes the selected item, keeping at least one (an empty ramp/curve has nothing to sample). */
  protected deleteSelected(): void {
    if (this.items.length <= 1) {
      return;
    }
    this.items.splice(this.selected, 1);
    this.selected = Math.min(this.selected, this.items.length - 1);
    this.render();
    this.emit();
  }

  /** Toggles the selected class across the existing handles in place (no rebuild). */
  protected markSelected(): void {
    Array.from(this.handleContainer.children).forEach((child, index) => {
      child.classList.toggle(this.selectedHandleClass, index === this.selected);
    });
  }

  /**
   * Wires a handle press: selects it in place (rebuilds only the inline editor, not the handle
   * DOM, so the pressed element's pointer capture survives) before the drag, then runs the
   * subclass `onMove` per move - this method owns the live/commit `emit` calls itself.
   */
  protected attachHandleDrag(
    handle: HTMLElement,
    index: number,
    onMove: (event: PointerEvent) => void,
  ): void {
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (this.selected !== index) {
        this.selected = index;
        this.markSelected();
        this.buildEditor();
      }
      this.activeDrag = beginPointerDrag(handle, event, {
        onMove: (moveEvent) => {
          onMove(moveEvent);
          this.emit(false);
        },
        onEnd: (_endEvent, dragged) => {
          this.activeDrag = undefined;
          if (dragged) {
            this.emit(true);
          }
        },
      });
    });
  }

  /** Coerces external data into a mutable, non-empty item list. */
  protected abstract normalize(value: TValue): TItem[];
  /** The current items as the value shape `onChange` / `setValue` speak. */
  protected abstract serialize(): TValue;
  /** Full rebuild: preview + handles + the selected item's inline editor. */
  protected abstract render(): void;
  /** Rebuilds just the selected item's inline editor (also called on a selection change). */
  protected abstract buildEditor(): void;
  /** Releases the inline editor's child components (called from dispose). */
  protected abstract disposeParts(): void;
}
