/**
 * Tiny imperative DOM helper. The UI is plain DOM built by hand - no framework. Panels rebuild
 * their own DOM in response to model events rather than diffing.
 */

type ElementChild = Node | string;

/** Typed listener map so `on: { click }` keeps the right event type per event name. */
type ElementEventListeners = {
  [Type in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[Type]) => void;
};

export interface ElementProperties {
  className?: string;
  textContent?: string;
  title?: string;
  /** `<button>`/`<input>` type (e.g. "button" so a button never submits a form). */
  type?: string;
  /** `data-*` values, keyed by their camelCase dataset name. */
  dataset?: Readonly<Record<string, string>>;
  /** Any other attributes (aria-*, role, tabindex, ...) set via setAttribute. */
  attributes?: Readonly<Record<string, string>>;
  on?: ElementEventListeners;
}

export function createElement<TTag extends keyof HTMLElementTagNameMap>(
  tag: TTag,
  properties: ElementProperties = {},
  children: readonly ElementChild[] = [],
): HTMLElementTagNameMap[TTag] {
  const element = document.createElement(tag);
  if (properties.className !== undefined) {
    element.className = properties.className;
  }
  if (properties.textContent !== undefined) {
    element.textContent = properties.textContent;
  }
  if (properties.title !== undefined) {
    element.title = properties.title;
  }
  if (properties.type !== undefined) {
    element.setAttribute("type", properties.type);
  }
  if (properties.dataset !== undefined) {
    for (const [key, value] of Object.entries(properties.dataset)) {
      element.dataset[key] = value;
    }
  }
  if (properties.attributes !== undefined) {
    for (const [name, value] of Object.entries(properties.attributes)) {
      element.setAttribute(name, value);
    }
  }
  if (properties.on !== undefined) {
    for (const [type, listener] of Object.entries(properties.on)) {
      element.addEventListener(type, listener as EventListener);
    }
  }
  for (const child of children) {
    element.append(child);
  }
  return element;
}

export function clearChildren(element: HTMLElement): void {
  let child = element.firstChild ?? undefined;
  while (child !== undefined) {
    child.remove();
    child = element.firstChild ?? undefined;
  }
}
