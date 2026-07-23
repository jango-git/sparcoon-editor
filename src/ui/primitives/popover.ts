/**
 * One floating-surface helper. The "append to body, position from an anchor, dismiss on
 * outside-press / Escape / scroll" machinery was reimplemented three times (dropdown, colorPicker,
 * contextMenu) with divergent dismiss rules. This unifies them behind one call.
 *
 * The caller builds and styles the content element (its class supplies the chrome); the popover
 * only owns placement and lifetime. Content must not be `display: none` - it is measured to clamp.
 */

const VIEWPORT_MARGIN = 8;

/** Below an anchor element's rectangle, or at a client point (context menus). */
export type PopoverAnchor =
  { readonly rectangle: DOMRect } | { readonly x: number; readonly y: number };

export interface PopoverOptions {
  readonly anchor: PopoverAnchor;
  /** Use the anchor rectangle's width as the popover's min-width (dropdowns). */
  readonly matchAnchorWidth?: boolean;
  /** Nudge the popover to stay fully on screen. Default true. */
  readonly clampToViewport?: boolean;
  /** Also dismiss on wheel / resize - the view moved under the popover. Default true. */
  readonly dismissOnScroll?: boolean;
  /** Presses inside these never dismiss (typically the trigger that toggles the popover). */
  readonly ignore?: Element | readonly Element[];
  readonly onDismiss?: () => void;
}

export interface PopoverHandle {
  readonly element: HTMLElement;
  close(): void;
}

export function openPopover(content: HTMLElement, options: PopoverOptions): PopoverHandle {
  const clampToViewport = options.clampToViewport ?? true;
  const dismissOnScroll = options.dismissOnScroll ?? true;
  const ignore = options.ignore === undefined ? [] : toElements(options.ignore);

  content.style.position = "fixed";
  content.style.visibility = "hidden";
  document.body.append(content);

  let left: number;
  let top: number;
  if ("rectangle" in options.anchor) {
    left = options.anchor.rectangle.left;
    top = options.anchor.rectangle.bottom;
    if (options.matchAnchorWidth === true) {
      content.style.minWidth = `${options.anchor.rectangle.width}px`;
    }
  } else {
    left = options.anchor.x;
    top = options.anchor.y;
  }

  if (clampToViewport) {
    const { width, height } = content.getBoundingClientRect();
    left = clampToRange(left, width, window.innerWidth);
    top = clampToRange(top, height, window.innerHeight);
  }
  content.style.left = `${left}px`;
  content.style.top = `${top}px`;
  content.style.visibility = "visible";

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    content.remove();
    window.removeEventListener("pointerdown", onOutsidePointer, true);
    window.removeEventListener("keydown", onKeyDown, true);
    if (dismissOnScroll) {
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("resize", close, true);
    }
    options.onDismiss?.();
  };

  const onOutsidePointer = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node) {
      if (content.contains(target) || ignore.some((element) => element.contains(target))) {
        return;
      }
    }
    close();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  window.addEventListener("pointerdown", onOutsidePointer, true);
  window.addEventListener("keydown", onKeyDown, true);
  if (dismissOnScroll) {
    window.addEventListener("wheel", close, true);
    window.addEventListener("resize", close, true);
  }

  return { element: content, close };
}

/** Keeps `start` so a `size`-wide span stays within `[MARGIN, limit - MARGIN]`. */
function clampToRange(start: number, size: number, limit: number): number {
  return Math.max(VIEWPORT_MARGIN, Math.min(start, limit - size - VIEWPORT_MARGIN));
}

function toElements(ignore: Element | readonly Element[]): readonly Element[] {
  return ignore instanceof Element ? [ignore] : ignore;
}
