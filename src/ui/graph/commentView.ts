/**
 * A comment box: a titled, resizable rectangle drawn behind the nodes to annotate or group a
 * region of the graph (a la Unreal Blueprints comments). It is never compiled - it is not a node
 * and lives in {@link EditorGraph.comments}; every edit on it is view-only.
 *
 * Only the header bar and the four corner handles capture pointer events; the body is click-through
 * (`pointer-events: none`) so nodes sitting over a comment stay fully interactive and a marquee can
 * still sweep across it. The canvas owns the drag/resize geometry (screen<->graph, grid-snapping,
 * enclosed-object detection) and this view only emits the raw pointer gestures, tagged by role,
 * plus commits the header text on edit.
 */

import { createElement } from "../dom";
import { t } from "../../i18n";

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

// Edges first, then corners, so the corner handles stack above the edges they overlap.
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
    // Double-click the header to rename; blur commits, Escape cancels the edit.
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

  public setSelected(selected: boolean): void {
    this.element.classList.toggle("comment--selected", selected);
  }

  private beginEdit(): void {
    this.editing = true;
    this.editStartText = this.header.textContent;
    this.header.contentEditable = "true";
    this.element.classList.add("comment--editing");
    this.header.focus();
    // Place the caret across the whole text so a rename can just start typing.
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
    // Drop focus so the caret leaves; a re-entrant blur -> endEdit is guarded by `editing`.
    this.header.blur();
  }
}
