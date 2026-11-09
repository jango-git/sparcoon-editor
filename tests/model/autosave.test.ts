import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave } from "../../src/persistence/autosave";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createAutosave", () => {
  it("writes once, an idle gap after the last of a burst of edits", () => {
    const save = vi.fn();
    const autosave = createAutosave(save, 400);
    autosave.schedule();
    vi.advanceTimersByTime(300);
    autosave.schedule(); // re-arms the gap
    vi.advanceTimersByTime(300);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending edit at once, cancelling its timer", () => {
    const save = vi.fn();
    const autosave = createAutosave(save, 400);
    autosave.schedule();
    autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("writes nothing on a flush with no edit pending", () => {
    const save = vi.fn();
    const autosave = createAutosave(save);
    autosave.flush();
    autosave.schedule();
    vi.advanceTimersByTime(400);
    autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
