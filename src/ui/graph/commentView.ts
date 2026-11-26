/**
 * Comment box behind the nodes. Not a node and never compiled. Only the header and corner handles
 * take pointer events, so nodes above it stay interactive. Emits raw pointer gestures. The canvas
 * owns geometry.
 */

import { t } from "../../i18n";
import { createElement, horizontalFrame, verticalFrame } from "../dom";
import { monoAdvance, wrappedLineCount } from "./monoText";

/**
 * Which edge or corner a resize gesture grabbed. A corner (`nw`/`ne`/`sw`/`se`) drags two
 * sides at once; a single letter (`n`/`e`/`s`/`w`) drags just that one side.
 */
export type CommentHandle = "n" | "e" | "s" | "w" | "nw" | "ne" | "sw" | "se";

export interface CommentViewHandlers {
  /** Header pressed (not while editing) - the canvas starts a move/enclose drag. */
  readonly onHeaderPointerDown: (event: PointerEvent) => void;
  /** An edge/corner handle pressed - the canvas starts a resize from that side. */
  readonly onHandlePointerDown: (event: PointerEvent, handle: CommentHandle) => void;
  /** The header text was committed (blur after an edit). */
  readonly onRename: (text: string) => void;
}

const HANDLES: readonly CommentHandle[] = ["n", "e", "s", "w", "nw", "ne", "sw", "se"];

export class CommentView {
  public readonly element: HTMLElement;
  private readonly header: HTMLElement;
  private editing = false;
  /** The header text when an edit began, restored if the edit is cancelled with Escape. */
  private editStartText = "";

  constructor(private readonly handlers: CommentViewHandlers) {
    this.header = createElement("div", { className: "comment__header" });
    this.header.textContent = t("graph.comment");

    // Drag by the header unless it is being edited (then let the caret/selection work).
    this.header.addEventListener("pointerdown", (event) => {
      if (this.editing || event.button !== 0) {
        return;
      }
      handlers.onHeaderPointerDown(event);
    });
    this.header.addEventListener("dblclick", () => this.beginEdit());
    this.header.addEventListener("blur", () => this.endEdit(true));
    this.header.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.endEdit(false);
      }
      // Enter inserts a newline (comments are multi-line) - do not commit on it.
      event.stopPropagation();
    });

    const handles = HANDLES.map((side) => {
      const handle = createElement("span", {
        className: `comment__handle comment__handle--${side}`,
      });
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
          return;
        }
        event.stopPropagation();
        handlers.onHandlePointerDown(event, side);
      });
      return handle;
    });

    this.element = createElement("div", { className: "comment" }, [this.header, ...handles]);
  }

  public setPosition(x: number, y: number): void {
    this.element.style.left = `${x}px`;
    this.element.style.top = `${y}px`;
  }

  public setSize(width: number, height: number): void {
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
  }

  public setText(text: string): void {
    if (!this.editing && this.header.textContent !== text) {
      this.header.textContent = text;
    }
  }

  /**
   * The header's height in a box `width` wide, the same in every browser (`monoText.ts`): its
   * lines wrapped at the most characters any browser fits on one.
   */
  public headerHeight(width: number): number {
    const style = getComputedStyle(this.header);
    const perLine = Math.floor(
      (width - horizontalFrame(getComputedStyle(this.element)) - horizontalFrame(style)) /
        monoAdvance(Number.parseFloat(style.fontSize)),
    );
    const lines = wrappedLineCount(this.header.textContent, perLine);
    return lines * Number.parseFloat(style.lineHeight) + verticalFrame(style);
  }

  public setSelected(selected: boolean): void {
    this.element.classList.toggle("comment--selected", selected);
  }

  private beginEdit(): void {
    this.editing = true;
    this.editStartText = this.header.textContent;
    this.header.contentEditable = "true";
    this.element.classList.add("comment--editing");
    this.header.focus();
    const range = document.createRange();
    range.selectNodeContents(this.header);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private endEdit(commit: boolean): void {
    if (!this.editing) {
      return;
    }
    this.editing = false;
    this.header.contentEditable = "false";
    this.element.classList.remove("comment--editing");
    if (commit) {
      this.handlers.onRename(this.header.textContent.trim() || t("graph.comment"));
    } else {
      // Cancelled: no commit fires (so no re-render), restore the text the edit started from.
      this.header.textContent = this.editStartText;
    }
    this.header.blur();
  }
}
