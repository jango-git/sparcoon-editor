import { describe, expect, it } from "vitest";

import { monoAdvance, wrappedLineCount } from "../../src/ui/graph/monoText";

describe("monoAdvance", () => {
  it("is the exact advance or the advance rounded to whole pixels, the larger", () => {
    expect(monoAdvance(10)).toBe(6);
    expect(monoAdvance(11)).toBe(7);
    expect(monoAdvance(12)).toBeCloseTo(7.2);
  });
});

describe("wrappedLineCount", () => {
  it("wraps at spaces, keeps a word whole while it fits a line, and splits a longer one", () => {
    expect(wrappedLineCount("Comment", 10)).toBe(1);
    expect(wrappedLineCount("spawn and motion", 10)).toBe(2);
    expect(wrappedLineCount("abcdefghijklmnopqrstuvwxy", 10)).toBe(3);
    expect(wrappedLineCount("one\ntwo", 10)).toBe(2);
  });
});
