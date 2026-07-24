/**
 * Declarative keyboard-shortcut vocabulary: a {@link Keymap} is a flat list of {@link KeyBinding}s
 * the {@link HotkeyRouter} matches against `keydown`. Matches on `event.code` (physical key), not
 * `event.key`, so a shortcut fires the same across keyboard layouts - the physical Z key always
 * undoes, whatever letter it produces on a given layout.
 */

export interface KeyBinding {
  /** Physical key, e.g. `"KeyF"`, `"Delete"`, `"Space"`, `"ArrowLeft"`. */
  readonly code: string;
  /** Require Ctrl (or Cmd on macOS). Omitted/false means the chord must *not* carry a modifier. */
  readonly modifier?: boolean;
  /** Require Shift. When omitted the binding is Shift-agnostic (matches with or without). */
  readonly shift?: boolean;
  /** Call `event.preventDefault()` before running (default `true`). */
  readonly preventDefault?: boolean;
  /** Fires even while a text field/contentEditable owns focus (default `false`, deferring to
   *  native text editing). Reserve for chords with no native text-editing meaning that must never
   *  fall through to the browser, like Ctrl+S opening its Save Page dialog. */
  readonly allowInEditable?: boolean;
  readonly run: (event: KeyboardEvent) => void;
}

export type Keymap = readonly KeyBinding[];

/** Whether `event` satisfies `binding`'s key + modifier requirements. */
export function matchesBinding(binding: KeyBinding, event: KeyboardEvent): boolean {
  if (binding.code !== event.code) {
    return false;
  }
  const modifierPressed = event.ctrlKey || event.metaKey;
  if ((binding.modifier ?? false) !== modifierPressed) {
    return false;
  }
  if (binding.shift !== undefined && binding.shift !== event.shiftKey) {
    return false;
  }
  return true;
}

/**
 * Runs the first binding in `keymap` that matches `event`. Returns `true` if one fired (and,
 * unless it opted out, `event.preventDefault()` was called), so the caller can stop dispatching.
 * `editableTarget` skips bindings that did not opt into {@link KeyBinding.allowInEditable}.
 */
export function runKeymap(
  keymap: Keymap,
  event: KeyboardEvent,
  editableTarget = false,
): boolean {
  for (const binding of keymap) {
    if (editableTarget && binding.allowInEditable !== true) {
      continue;
    }
    if (matchesBinding(binding, event)) {
      if (binding.preventDefault !== false) {
        event.preventDefault();
      }
      binding.run(event);
      return true;
    }
  }
  return false;
}
