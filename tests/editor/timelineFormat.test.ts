import { describe, expect, it, vi } from "vitest";

import { eulerToQuat } from "../../src/model/transform";
import {
  describeEvent,
  describeReaction,
  formatChannel,
  formatValue,
  fraction,
  rangeSpan,
  rangeStart,
  spanFraction,
  timeAtFraction,
  trimNumber,
} from "../../src/ui/panels/timelineFormat";

// The runtime `t()` fetches its dictionary over HTTP, unavailable under node; resolve keys from
// the bundled English dictionary instead, through the real placeholder substitution.
vi.mock("../../src/i18n", async () => {
  const { default: en } = await import("../../src/i18n/locales/en.json", {
    with: { type: "json" },
  });
  const { interpolate } = await import("../../src/i18n/interpolate");
  const lookup = (key: string): string => {
    const entry = key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], en);
    if (typeof entry !== "string") {
      throw new Error(`no English string for ${key}`);
    }
    return entry;
  };
  return {
    t: (key: string, parameters?: Record<string, string | number>): string =>
      interpolate("en", lookup(key), parameters),
  };
});

// A 5 s timeline's lane is padded by 20% on both sides: it spans [-1, 6] s.
const TOTAL = 5;

describe("timeline lane mapping", () => {
  it("pads the lane window on both sides of the authored duration", () => {
    expect(rangeStart(TOTAL)).toBeCloseTo(-1, 9);
    expect(rangeSpan(TOTAL)).toBeCloseTo(7, 9);
  });

  it("maps a time to its fraction along the padded lane", () => {
    expect(fraction(-1, TOTAL)).toBe(0);
    expect(fraction(0, TOTAL)).toBeCloseTo(1 / 7, 9);
    expect(fraction(2.5, TOTAL)).toBeCloseTo(0.5, 9);
    expect(fraction(6, TOTAL)).toBeCloseTo(1, 9);
  });

  it("clamps a time outside the padded window to the lane's edges", () => {
    expect(fraction(-10, TOTAL)).toBe(0);
    expect(fraction(100, TOTAL)).toBe(1);
  });

  it("timeAtFraction inverts fraction across the lane", () => {
    for (const time of [-1, -0.5, 0, 1.25, 2.5, 5, 6]) {
      expect(timeAtFraction(fraction(time, TOTAL), TOTAL)).toBeCloseTo(time, 9);
    }
    expect(timeAtFraction(0, TOTAL)).toBeCloseTo(-1, 9);
    expect(timeAtFraction(1, TOTAL)).toBeCloseTo(6, 9);
  });

  it("measures a duration as a fraction of the lane width, unclamped", () => {
    expect(spanFraction(7, TOTAL)).toBeCloseTo(1, 9);
    expect(spanFraction(3.5, TOTAL)).toBeCloseTo(0.5, 9);
    // A drag delta may run backwards or past the lane.
    expect(spanFraction(-14, TOTAL)).toBeCloseTo(-2, 9);
  });

  it("maps everything to 0 on a zero-length timeline instead of dividing by zero", () => {
    expect(fraction(1, 0)).toBe(0);
    expect(spanFraction(1, 0)).toBe(0);
  });
});

describe("timeline value formatting", () => {
  it("trims numbers to at most three decimals with no trailing zeros", () => {
    expect(trimNumber(2)).toBe("2");
    expect(trimNumber(1.23456)).toBe("1.235");
    expect(trimNumber(0.1 + 0.2)).toBe("0.3");
    expect(trimNumber(-0.0001)).toBe("0");
  });

  it("formats a scalar bare and a vector as a bracketed list", () => {
    expect(formatValue(4.5)).toBe("4.5");
    expect(formatValue([1, 2.5, 1 / 3])).toBe("[1, 2.5, 0.333]");
  });

  it("formats a rotation key's quaternion as Euler degrees", () => {
    expect(formatChannel("rotation", eulerToQuat([0, 90, 0]))).toBe("[0, 90, 0]deg");
    expect(formatChannel("rotation", [0, 0, 0, 1])).toBe("[0, 0, 0]deg");
  });

  it("formats position and scale keys as their raw vectors", () => {
    expect(formatChannel("position", [1, 2, 3])).toBe("[1, 2, 3]");
    expect(formatChannel("scale", [2, 2, 2])).toBe("[2, 2, 2]");
  });
});

describe("describeEvent", () => {
  it("describes a burst by its time and count", () => {
    expect(describeEvent({ id: "e", kind: "burst", time: 1.5, count: 10 })).toBe(
      "Burst · 1.5s · 10",
    );
  });

  it("describes a timed play by its time, rate and duration", () => {
    expect(describeEvent({ id: "e", kind: "play", time: 1, rate: 12.5, duration: 2 })).toBe(
      "Play · 1s · 12.5/s · 2s",
    );
  });

  it("describes a play with no positive duration as infinite", () => {
    for (const duration of [0, -1]) {
      expect(describeEvent({ id: "e", kind: "play", time: 1, rate: 10, duration })).toBe(
        "Play · 1s · 10/s · infinite",
      );
    }
  });
});

describe("describeReaction", () => {
  it("names the source and what each death spawns", () => {
    expect(describeReaction({ id: "r", source: "s", kind: "burst", count: 4 }, "Shell")).toBe(
      "When a particle of Shell dies: burst 4 there, one frame later.",
    );
    expect(
      describeReaction({ id: "r", source: "s", kind: "play", rate: 12.5, duration: 0.25 }, "Shell"),
    ).toBe("When a particle of Shell dies: play 12.5/s for 0.25s there, one frame later.");
  });
});
