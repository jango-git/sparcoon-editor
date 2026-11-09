import { describe, expect, it } from "vitest";
import type { FXScalarLocal } from "../../src/engine/core/codegen/cse.Internal";
import {
  commonSubexpressionElimination,
  partitionByInvariance,
} from "../../src/engine/core/codegen/cse.Internal";
import type { FXExpr } from "../../src/engine/core/ir/FXExpr";
import { add, lit, mul, raw, ref } from "../../src/engine/core/ir/FXExprBuilder";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";

const FLOAT = FX_VALUE_TYPES.float;
const isImpureCall = (fn: string): boolean => fn === "rand";

function rand(): FXExpr {
  return { kind: "call", type: FLOAT, fn: "rand", args: [] };
}

function sqrt(argument: FXExpr): FXExpr {
  return { kind: "call", type: FLOAT, fn: "sqrt", args: [argument] };
}

function cse(locals: readonly FXScalarLocal[]): FXScalarLocal[] {
  let next = 0;
  return commonSubexpressionElimination(locals, (hint) => `${hint}${String(next++)}`, isImpureCall);
}

const x = ref("attribute", "x", FLOAT);
const y = ref("attribute", "y", FLOAT);
const local = (name: string): FXExpr => ref("local", name, FLOAT);

describe("commonSubexpressionElimination", () => {
  it("extracts a pure subtree shared by two locals into one named local, emitted first", () => {
    const shared = (): FXExpr => sqrt(mul(x, x));
    const output = cse([
      { name: "a", expr: add(shared(), lit(1)) },
      { name: "b", expr: add(shared(), lit(2)) },
    ]);

    expect(output.map((entry) => entry.name)).toEqual(["cse0", "a", "b"]);
    expect(output[0]?.expr).toEqual(sqrt(mul(x, x)));
    expect(output[1]?.expr).toEqual(add(local("cse0"), lit(1)));
    expect(output[2]?.expr).toEqual(add(local("cse0"), lit(2)));
  });

  it("emits a nested shared subtree before the shared subtree that uses it", () => {
    const inner = (): FXExpr => mul(x, y);
    const outer = (): FXExpr => sqrt(inner());
    const output = cse([
      { name: "a", expr: add(outer(), inner()) },
      { name: "b", expr: add(outer(), lit(3)) },
    ]);

    // `cse1` (x * y) is used by `cse0` (sqrt) and by `a`, so it lands before both.
    expect(output).toEqual([
      { name: "cse1", expr: mul(x, y) },
      { name: "cse0", expr: sqrt(local("cse1")) },
      { name: "a", expr: add(local("cse0"), local("cse1")) },
      { name: "b", expr: add(local("cse0"), lit(3)) },
    ]);
  });

  it("never merges impure calls: identical zero-arg rand() draws stay independent", () => {
    const output = cse([
      { name: "a", expr: add(rand(), rand()) },
      { name: "b", expr: rand() },
    ]);

    expect(output.map((entry) => entry.name)).toEqual(["a", "b"]);
    expect(output[0]?.expr).toEqual(add(rand(), rand()));
    expect(output[1]?.expr).toEqual(rand());
  });

  it("never merges raw nodes, so pure parents over distinct raws stay distinct too", () => {
    const draw = (): FXExpr => raw(FLOAT, "js", "Math.random()");
    const output = cse([
      { name: "a", expr: mul(draw(), lit(2)) },
      { name: "b", expr: mul(draw(), lit(2)) },
    ]);

    // Each `mul` sits over its own raw draw, so neither is shared.
    expect(output.map((entry) => entry.name)).toEqual(["a", "b"]);
  });
});

describe("partitionByInvariance", () => {
  const isInvariantRef = (candidate: Extract<FXExpr, { kind: "ref" }>): boolean =>
    candidate.ref === "uniform";
  const uniform = ref("uniform", "u", FLOAT);

  function partition(locals: readonly FXScalarLocal[]): { preLoop: string[]; body: string[] } {
    const { preLoop, body } = partitionByInvariance(locals, isInvariantRef, isImpureCall);
    return {
      preLoop: preLoop.map((entry) => entry.name),
      body: body.map((entry) => entry.name),
    };
  }

  it("hoists locals built only from literals and invariant refs, in order", () => {
    expect(
      partition([
        { name: "k", expr: mul(uniform, lit(2)) },
        { name: "s", expr: sqrt(lit(4)) },
      ]),
    ).toEqual({ preLoop: ["k", "s"], body: [] });
  });

  it("never hoists an impure call, even a zero-arg one with no variant child", () => {
    expect(
      partition([
        { name: "r", expr: rand() },
        { name: "scaled", expr: mul(rand(), uniform) },
      ]),
    ).toEqual({ preLoop: [], body: ["r", "scaled"] });
  });

  it("keeps everything that depends on a per-particle value in the body, through local refs", () => {
    expect(
      partition([
        { name: "k", expr: mul(uniform, lit(2)) },
        { name: "v", expr: add(x, local("k")) },
        { name: "w", expr: mul(local("v"), lit(3)) },
        { name: "r", expr: raw(FLOAT, "js", "Math.random()") },
        { name: "k2", expr: add(local("k"), lit(1)) },
      ]),
    ).toEqual({ preLoop: ["k", "k2"], body: ["v", "w", "r"] });
  });

  it("treats a local ref it has not seen yet as variant", () => {
    expect(partition([{ name: "a", expr: add(local("later"), lit(1)) }])).toEqual({
      preLoop: [],
      body: ["a"],
    });
  });
});
