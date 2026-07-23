/**
 * The shared contract every UI primitive/component honours, ending the class-vs-factory split
 * and the missing-teardown leak (body-appended popovers + window listeners outliving their owner).
 */

export interface UiComponent {
  readonly element: HTMLElement;
  /** Releases listeners, open popovers and child components; safe to call more than once. */
  dispose(): void;
}

export interface ValueComponent<TValue> extends UiComponent {
  /** Re-syncs the shown value from model state (undo / redo) without firing onChange. */
  setValue(value: TValue): void;
}

/**
 * Collects teardown callbacks so a component's `dispose()` is one call. `listen` pairs an
 * addEventListener with its removeEventListener automatically - the source of the current leaks.
 */
export class DisposerBag {
  private readonly disposers: (() => void)[] = [];

  public add(disposer: () => void): void {
    this.disposers.push(disposer);
  }

  public listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.add(() => target.removeEventListener(type, listener, options));
  }

  public dispose(): void {
    // Splice first so a disposer that re-enters dispose() can't run the list twice.
    for (const disposer of this.disposers.splice(0)) {
      disposer();
    }
  }
}
