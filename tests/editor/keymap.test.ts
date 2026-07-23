import { describe, expect, it, vi } from "vitest";
import { matchesBinding, runKeymap, type KeyBinding } from "../../src/ui/focus/keymap";

/**
 * The keymap matcher is the pure core of the hotkey router: it decides whether a keystroke
 * satisfies a binding's physical key + modifier requirements, and dispatches the first match.
 * These tests pin that logic (layout-independent `code` matching, modifier strictness, and the
 * Shift-agnostic default) without a DOM - a minimal event stand-in carries the fields it reads.
 */

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    code: "KeyA",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("matchesBinding", () => {
  it("matches on the physical code regardless of layout-produced character", () => {
    const binding: KeyBinding = { code: "KeyZ", modifier: true, run: () => {} };
    // A non-Latin layout produces a different letter but still reports code "KeyZ".
    expect(matchesBinding(binding, keyEvent({ code: "KeyZ", ctrlKey: true }))).toBe(true);
    expect(matchesBinding(binding, keyEvent({ code: "KeyX", ctrlKey: true }))).toBe(false);
  });

  it("treats a missing modifier as requiring no modifier", () => {
    const plain: KeyBinding = { code: "KeyC", run: () => {} };
    expect(matchesBinding(plain, keyEvent({ code: "KeyC" }))).toBe(true);
    expect(matchesBinding(plain, keyEvent({ code: "KeyC", ctrlKey: true }))).toBe(false);
  });

  it("accepts either Ctrl or Meta for a modifier binding", () => {
    const binding: KeyBinding = { code: "KeyV", modifier: true, run: () => {} };
    expect(matchesBinding(binding, keyEvent({ code: "KeyV", ctrlKey: true }))).toBe(true);
    expect(matchesBinding(binding, keyEvent({ code: "KeyV", metaKey: true }))).toBe(true);
  });

  it("is Shift-agnostic unless shift is specified", () => {
    const agnostic: KeyBinding = { code: "Delete", run: () => {} };
    expect(matchesBinding(agnostic, keyEvent({ code: "Delete", shiftKey: true }))).toBe(true);
    expect(matchesBinding(agnostic, keyEvent({ code: "Delete", shiftKey: false }))).toBe(true);

    const redo: KeyBinding = { code: "KeyZ", modifier: true, shift: true, run: () => {} };
    expect(matchesBinding(redo, keyEvent({ code: "KeyZ", ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(matchesBinding(redo, keyEvent({ code: "KeyZ", ctrlKey: true, shiftKey: false }))).toBe(
      false,
    );
  });
});

describe("runKeymap", () => {
  it("runs the first matching binding and reports the hit", () => {
    const first = vi.fn();
    const second = vi.fn();
    const keymap: KeyBinding[] = [
      { code: "KeyF", run: first },
      { code: "KeyF", run: second },
    ];
    expect(runKeymap(keymap, keyEvent({ code: "KeyF" }))).toBe(true);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("distinguishes the plain and modifier bindings of the same key", () => {
    const copy = vi.fn();
    const comment = vi.fn();
    // Same ordering the graph uses: Ctrl+C copies, a plain C makes a comment.
    const keymap: KeyBinding[] = [
      { code: "KeyC", modifier: true, run: copy },
      { code: "KeyC", run: comment },
    ];
    runKeymap(keymap, keyEvent({ code: "KeyC", ctrlKey: true }));
    expect(copy).toHaveBeenCalledOnce();
    expect(comment).not.toHaveBeenCalled();

    runKeymap(keymap, keyEvent({ code: "KeyC" }));
    expect(comment).toHaveBeenCalledOnce();
  });

  it("preventDefault fires by default but is skipped when opted out", () => {
    const withDefault = keyEvent({ code: "KeyV" });
    runKeymap([{ code: "KeyV", run: () => {} }], withDefault);
    expect(withDefault.preventDefault).toHaveBeenCalledOnce();

    const optedOut = keyEvent({ code: "KeyC" });
    runKeymap([{ code: "KeyC", run: () => {}, preventDefault: false }], optedOut);
    expect(optedOut.preventDefault).not.toHaveBeenCalled();
  });

  it("returns false and runs nothing when no binding matches", () => {
    const run = vi.fn();
    expect(runKeymap([{ code: "KeyA", run }], keyEvent({ code: "KeyB" }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
