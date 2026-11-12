import { describe, expect, it } from "vitest";

import { foldScalarLocals } from "../../src/engine/core/codegen/foldScalars.Internal";
import type { FXExpr } from "../../src/engine/core/ir/FXExpr";
import { add, lit, mul, ref, sub } from "../../src/engine/core/ir/FXExprBuilder";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";

const FLOAT = FX_VALUE_TYPES.float;
const time = ref("targetInput", "u_time", FLOAT);
const local = (name: string): FXExpr => ref("local", name, FLOAT);

describe("foldScalarLocals", () => {
  it("folds arithmetic on literals into what reads it, dropping the constant", () => {
    const folded = foldScalarLocals(
      [
        { name: "half", expr: mul(lit(0.5), lit(3)) },
        { name: "out", expr: mul(time, local("half")) },
      ],
      new Set(["out"]),
    );
    expect(folded).toEqual([{ name: "out", expr: mul(time, lit(1.5)) }]);
  });

  it("drops the identities an identity matrix leaves behind", () => {
    // One row of identity * m: 1*a + 0*b - 0 reads `a` alone.
    const folded = foldScalarLocals(
      [
        {
          name: "out",
          expr: sub(add(mul(lit(1), time), mul(lit(0), local("other"))), lit(0)),
        },
      ],
      new Set(["out"]),
    );
    expect(folded).toEqual([{ name: "out", expr: time }]);
  });

  it("keeps a written value even when it folds to a literal", () => {
    expect(foldScalarLocals([{ name: "w", expr: add(lit(1), lit(2)) }], new Set(["w"]))).toEqual([
      { name: "w", expr: lit(3) },
    ]);
  });

  it("leaves what it cannot fold as it is", () => {
    const locals = [{ name: "out", expr: mul(time, local("x")) }];
    expect(foldScalarLocals(locals, new Set(["out"]))).toEqual(locals);
  });
});
