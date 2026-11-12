import { describe, expect, it } from "vitest";

import { hoistToEarlyStage } from "../../src/engine/core/codegen/hoist.Internal";
import type { FXRatedLocal, FXRatePolicy } from "../../src/engine/core/codegen/rates.Internal";
import { classifyRates, operationCount } from "../../src/engine/core/codegen/rates.Internal";
import type { FXExpr } from "../../src/engine/core/ir/FXExpr";
import { add, lit, mul, pureRaw, raw, ref, swizzle } from "../../src/engine/core/ir/FXExprBuilder";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";

const FLOAT = FX_VALUE_TYPES.float;
const VEC2 = FX_VALUE_TYPES.vec2;

// Ranks as the render backend uses them: draw 1, primitive 2, vertex 3, fragment 4.
const INPUT_RATES: Readonly<Record<string, number>> = {
  time: 1,
  age: 2,
  offset: 2,
  uv: 3,
  frontFacing: 4,
};
const POLICY: FXRatePolicy = {
  rateOfRef: (reference) => INPUT_RATES[reference.name] ?? 4,
  isImpureCall: (fn) => fn === "rand",
  pinned: 4,
};

const input = (name: string, type = FLOAT): FXExpr => ref("targetInput", name, type);
const local = (name: string, type = FLOAT): FXExpr => ref("local", name, type);
const define = (name: string, expr: FXExpr): FXRatedLocal => ({ name, expr });
const names = (locals: readonly FXRatedLocal[]): string[] => locals.map((entry) => entry.name);

describe("classifyRates", () => {
  it("joins the rates of everything a local reads, literals being constant", () => {
    const rates = classifyRates(
      [
        define("k", mul(lit(2), lit(3))),
        define("t", add(input("time"), local("k"))),
        define("a", mul(input("age"), local("t"))),
        define("u", mul(swizzle(input("uv", VEC2), "x"), local("a"))),
      ],
      POLICY,
    );
    expect(Object.fromEntries(rates)).toEqual({ k: 0, t: 1, a: 2, u: 3 });
  });

  it("pins a raw not marked pure, an impure call and an unknown local; follows a pure raw", () => {
    const rates = classifyRates(
      [
        define("pinnedRaw", raw(FLOAT, "glsl", "f($0)", input("age"))),
        define("pureRaw", pureRaw(FLOAT, "glsl", "f($0)", input("age"))),
        define("impure", { kind: "call", type: FLOAT, fn: "rand", args: [] }),
        define("unknown", local("elsewhere")),
      ],
      POLICY,
    );
    expect(Object.fromEntries(rates)).toEqual({ pinnedRaw: 4, pureRaw: 2, impure: 4, unknown: 4 });
  });

  it("counts arithmetic, not data movement", () => {
    expect(operationCount(swizzle(input("uv", VEC2), "x"))).toBe(0);
    expect(operationCount(add(mul(lit(1), input("age")), lit(2)))).toBe(2);
  });
});

/** Places `early`/`late` with the render-like policy, every crossing fitting unless `fits` says. */
function place(
  early: readonly FXRatedLocal[],
  late: readonly FXRatedLocal[],
  lateRoots: readonly string[],
  fits: (crossing: readonly FXRatedLocal[]) => boolean = () => true,
): ReturnType<typeof hoistToEarlyStage<FXRatedLocal>> {
  return hoistToEarlyStage(
    { early, late, lateRoots },
    { rates: classifyRates([...early, ...late], POLICY), maxRate: 2, sharedRate: 1, fits },
  );
}

describe("hoistToEarlyStage", () => {
  it("moves a per-primitive chain the late stage reads and carries only its top", () => {
    const placed = place(
      [define("ratio", mul(input("age"), lit(0.5)))],
      [
        define("curve", mul(local("ratio"), local("ratio"))),
        define("faded", add(local("curve"), lit(1))),
        define("shade", mul(swizzle(input("uv", VEC2), "x"), local("faded"))),
      ],
      ["shade"],
    );
    expect(names(placed.early)).toEqual(["ratio", "curve", "faded"]);
    expect(names(placed.late)).toEqual(["shade"]);
    expect(names(placed.crossing)).toEqual(["faded"]);
  });

  it("keeps per-vertex and per-fragment values where they are", () => {
    const placed = place(
      [],
      [
        define("u", mul(swizzle(input("uv", VEC2), "x"), lit(2))),
        define("face", mul(input("frontFacing"), lit(2))),
      ],
      ["u", "face"],
    );
    expect(names(placed.early)).toEqual([]);
    expect(names(placed.late)).toEqual(["u", "face"]);
  });

  it("gives back a moved top that only moves data, carrying what it reads instead", () => {
    const placed = place(
      [],
      [
        define("scaled", mul(input("offset", VEC2), lit(3))),
        define("alias", swizzle(local("scaled", VEC2), "y")),
        define("out", mul(local("alias"), swizzle(input("uv", VEC2), "y"))),
      ],
      ["out"],
    );
    expect(names(placed.early)).toEqual(["scaled"]);
    expect(names(placed.late)).toEqual(["alias", "out"]);
    expect(names(placed.crossing)).toEqual(["scaled"]);
  });

  it("defines an alias of a uniform in each stage that reads it, never carrying it", () => {
    // The Dome's case: a moved chain reads the alias, and the late stage reads it directly too.
    const placed = place(
      [],
      [
        define("clock", input("time")),
        define("sweep", mul(local("clock"), lit(0.5))),
        define("out", add(mul(local("sweep"), local("clock")), swizzle(input("uv", VEC2), "x"))),
      ],
      ["out"],
    );
    expect(names(placed.early)).toEqual(["clock", "sweep"]);
    expect(names(placed.late)).toEqual(["clock", "out"]);
    expect(names(placed.crossing)).toEqual(["sweep"]);
  });

  it("defines nothing in a stage for a value it only reads across the boundary", () => {
    const placed = place(
      [],
      [
        define("k", mul(lit(2), lit(3))),
        define("fade", mul(local("k"), input("age"))),
        define("out", mul(local("fade"), swizzle(input("uv", VEC2), "x"))),
      ],
      ["out"],
    );
    expect(names(placed.crossing)).toEqual(["fade"]);
    expect(names(placed.late)).toEqual(["out"]);
  });

  it("carries a free alias of a computed value: only what reads uniforms alone is shared", () => {
    const placed = place(
      [],
      [
        define("scaled", mul(input("time"), lit(3))),
        define("alias", local("scaled")),
        define("lifted", mul(local("alias"), input("age"))),
        define("out", add(mul(local("lifted"), local("alias")), swizzle(input("uv", VEC2), "x"))),
      ],
      ["out"],
    );
    // `alias` is free and draw-rate but reads a computed local, which the late stage does not
    // have: it is not defined everywhere, and crosses like any moved value.
    expect(names(placed.late)).toEqual(["out"]);
    expect(names(placed.crossing)).toEqual(["alias", "lifted"]);
  });

  it("defines a constant in each stage that reads it instead of carrying it", () => {
    const placed = place(
      [define("k", mul(lit(2), lit(3))), define("v", mul(local("k"), input("age")))],
      [define("w", mul(local("k"), swizzle(input("uv", VEC2), "x")))],
      ["w"],
    );
    expect(names(placed.late)).toEqual(["k", "w"]);
    expect(names(placed.crossing)).toEqual([]);

    const moved = place(
      [],
      [
        define("k", mul(lit(2), lit(3))),
        define("a", mul(local("k"), input("age"))),
        define("b", mul(local("k"), mul(local("a"), swizzle(input("uv", VEC2), "x")))),
      ],
      ["b"],
    );
    expect(names(moved.early)).toEqual(["k", "a"]);
    expect(names(moved.late)).toEqual(["k", "b"]);
    expect(names(moved.crossing)).toEqual(["a"]);
  });

  it("drops a late local nothing reads, so it carries nothing either", () => {
    const placed = place(
      [define("v", mul(input("age"), lit(2)))],
      [
        define("dead", mul(local("v"), swizzle(input("uv", VEC2), "x"))),
        define("out", mul(input("frontFacing"), lit(1))),
      ],
      ["out"],
    );
    expect(names(placed.late)).toEqual(["out"]);
    expect(names(placed.crossing)).toEqual([]);
  });

  it("gives back the cheapest moves until the crossing fits", () => {
    const late = [
      define("cheap", mul(input("age"), lit(2))),
      define("dear", mul(mul(mul(input("age"), lit(2)), lit(3)), lit(4))),
      define("out", mul(add(local("cheap"), local("dear")), swizzle(input("uv", VEC2), "x"))),
    ];
    const placed = place([], late, ["out"], (crossing) => crossing.length <= 1);
    expect(names(placed.early)).toEqual(["dear"]);
    expect(names(placed.crossing)).toEqual(["dear"]);
    expect(names(placed.late)).toEqual(["cheap", "out"]);
  });

  it("adds nothing to a crossing that does not fit to begin with", () => {
    const placed = place(
      [define("already", mul(input("age"), lit(5)))],
      [
        define("more", mul(input("age"), lit(2))),
        define("out", mul(add(local("already"), local("more")), swizzle(input("uv", VEC2), "x"))),
      ],
      ["out"],
      () => false,
    );
    expect(names(placed.crossing)).toEqual(["already"]);
    expect(names(placed.late)).toEqual(["more", "out"]);
  });
});
