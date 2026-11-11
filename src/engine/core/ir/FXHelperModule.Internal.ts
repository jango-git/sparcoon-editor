/** Helper source other helpers can depend on, so a shared primitive is emitted once per shader. */
export interface FXHelperModule {
  readonly key: string;
  readonly source: string;
  readonly requires?: readonly FXHelperModule[];
}

/** A function's helper: a self-contained source keyed by the function name, or a module. */
export type FXHelper = string | FXHelperModule;

/**
 * Adds `helper` to `into` after its dependencies. Insertion order is emission order and keys are
 * never re-added, so merged maps keep every dependency ahead of its dependents.
 */
export function collectHelper(
  into: Map<string, string>,
  functionName: string,
  helper: FXHelper,
): void {
  if (typeof helper === "string") {
    if (!into.has(functionName)) {
      into.set(functionName, helper);
    }
    return;
  }
  for (const dependency of helper.requires ?? []) {
    collectHelper(into, dependency.key, dependency);
  }
  if (!into.has(helper.key)) {
    into.set(helper.key, helper.source);
  }
}
