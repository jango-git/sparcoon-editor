/**
 * The single `keydown` entry point: one window listener that skips editable targets (a text field /
 * contentEditable owns its own keystrokes) for most bindings, then tries the global keymap, then
 * the active panel's keymap. A binding can opt into firing even over an editable target via
 * {@link KeyBinding.allowInEditable} - reserved for chords like Ctrl+S with no native text-editing
 * meaning, where falling through to the browser is never wanted. Reads {@link PanelFocus} live on
 * every keystroke, so switching panels switches keymaps with no re-registration.
 */

import type { EditorPanel, PanelFocus } from "./panelFocus";
import { runKeymap, type KeyBinding, type Keymap } from "./keymap";

/** Whether the focused element is a text field that owns its own keystrokes. */
export function isEditableTarget(target: EventTarget | undefined): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export class HotkeyRouter {
  private readonly globalKeymap: KeyBinding[] = [];
  // Panels may register more than once (the transport keymap and the panel's own editing keys
  // both target the Timeline), so keymaps accumulate per panel rather than replacing.
  private readonly panelKeymaps = new Map<EditorPanel, KeyBinding[]>();

  constructor(private readonly focus: PanelFocus) {
    window.addEventListener("keydown", (event) => this.onKeyDown(event));
  }

  /** Adds to the always-live keymap (undo / redo). */
  public registerGlobal(keymap: Keymap): void {
    this.globalKeymap.push(...keymap);
  }

  /** Adds a keymap applied only while `panel` is the active panel. */
  public registerPanel(panel: EditorPanel, keymap: Keymap): void {
    const existing = this.panelKeymaps.get(panel);
    if (existing === undefined) {
      this.panelKeymaps.set(panel, [...keymap]);
    } else {
      existing.push(...keymap);
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    // A field being typed into (including a comment header being renamed) owns its keystrokes,
    // protecting native chords like Ctrl+C/Ctrl+V inside an input - unless the binding opted into
    // allowInEditable (Ctrl+S has no such native meaning and must never reach the browser).
    const editableTarget = isEditableTarget(event.target ?? undefined);
    if (runKeymap(this.globalKeymap, event, editableTarget)) {
      return;
    }
    if (editableTarget) {
      return;
    }
    const panelKeymap = this.panelKeymaps.get(this.focus.get());
    if (panelKeymap !== undefined) {
      runKeymap(panelKeymap, event);
    }
  }
}
