/**
 * A Blender-style vertical tab strip on one edge of the viewport, each tab opening its own panel
 * inward. At most one panel is open; pressing the open tab collapses it, and the strip stays as the
 * handle that reopens one. A drag begun on a tab still orbits the camera.
 */

import { createElement } from "../dom";
import { icon } from "../icons";
import { attachTooltip } from "./tooltip";

/** Which viewport edge the strip sits on; its panels open toward the middle. */
export type ViewportTabsSide = "left" | "right";

export interface ViewportTab {
  /**
   * Marks the tab while something it controls departs from the default (the overdraw view is
   * on), so the state shows with the panel collapsed.
   */
  setMarked(marked: boolean): void;
}

export interface ViewportTabs {
  readonly element: HTMLElement;
  /** Adds a tab whose panel holds `content`; tabs stack in the order they are added. */
  addTab(label: string, glyph: string, description: string, content: HTMLElement[]): ViewportTab;
  /** Collapses or reopens the last open tab's panel. */
  toggle(): void;
  /** Collapses the open panel, if any. */
  collapse(): void;
  /**
   * Collapses the open panel on any press or wheel in `host` outside the strip and the panel, so
   * an open panel does not linger over the scene once the viewport is worked in.
   */
  collapseOnInteraction(host: HTMLElement): void;
}

// A tab press can't rely on the browser `click`: the orbit controls' pointer capture on the same
// press suppresses it. The tab records its press, and a pointerup within this many pixels of it
// opens the tab; a bigger move was an orbit.
const TAB_DRAG_THRESHOLD = 4;

export function createViewportTabs(side: ViewportTabsSide): ViewportTabs {
  const strip = createElement("div", { className: "viewport-tabs__strip" });
  const content = createElement("div", { className: "viewport-tabs__content" });
  const element = createElement(
    "div",
    { className: `viewport-tabs viewport-tabs--${side}` },
    side === "left" ? [strip, content] : [content, strip],
  );
  // An open panel captures its own gestures; the strip is left to bubble, so it is no dead zone.
  content.addEventListener("pointerdown", (event) => event.stopPropagation());

  const groups: { tab: HTMLElement; panel: HTMLElement }[] = [];
  let activeIndex = 0;
  let collapsed = true;

  const paint = (): void => {
    groups.forEach((group, index) => {
      const open = !collapsed && index === activeIndex;
      group.tab.classList.toggle("viewport-tabs__tab--active", open);
      group.panel.classList.toggle("viewport-tabs__panel--open", open);
    });
  };

  const activate = (index: number): void => {
    if (!collapsed && index === activeIndex) {
      collapsed = true;
    } else {
      activeIndex = index;
      collapsed = false;
    }
    paint();
  };

  let pendingTab: number | undefined;
  let downX = 0;
  let downY = 0;
  window.addEventListener("pointerup", (event) => {
    if (pendingTab === undefined) {
      return;
    }
    const index = pendingTab;
    pendingTab = undefined;
    if (
      Math.abs(event.clientX - downX) <= TAB_DRAG_THRESHOLD &&
      Math.abs(event.clientY - downY) <= TAB_DRAG_THRESHOLD
    ) {
      activate(index);
    }
  });
  // A cancelled gesture must not leave a press pending for the next pointerup.
  window.addEventListener("pointercancel", () => {
    pendingTab = undefined;
  });

  const collapse = (): void => {
    if (!collapsed) {
      collapsed = true;
      paint();
    }
  };

  return {
    element,
    addTab(label, glyph, description, children): ViewportTab {
      const index = groups.length;
      const tab = createElement("button", { className: "viewport-tabs__tab" });
      tab.type = "button";
      attachTooltip(tab, label, description);
      tab.append(
        icon(glyph),
        createElement("span", { className: "viewport-tabs__tab-label", textContent: label }),
      );
      tab.addEventListener("pointerdown", (event) => {
        pendingTab = index;
        downX = event.clientX;
        downY = event.clientY;
      });
      const panel = createElement("div", { className: "viewport-tabs__panel" }, children);
      strip.append(tab);
      content.append(panel);
      groups.push({ tab, panel });
      paint();
      return {
        setMarked: (marked) => tab.classList.toggle("viewport-tabs__tab--marked", marked),
      };
    },
    toggle(): void {
      collapsed = !collapsed;
      paint();
    },
    collapse,
    collapseOnInteraction(host): void {
      const onInteraction = (event: Event): void => {
        if (!(event.target instanceof Node && strip.contains(event.target))) {
          collapse();
        }
      };
      host.addEventListener("pointerdown", onInteraction);
      host.addEventListener("wheel", onInteraction);
    },
  };
}
