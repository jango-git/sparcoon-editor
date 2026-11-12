import type { FXExpr } from "../ir/FXExpr";
import { lit } from "../ir/FXExprBuilder";
import { childrenOf, replaceRefs, withChildren } from "../ir/visit.Internal";
import type { FXScalarLocal } from "./cse.Internal";

/**
 * Folds the constant arithmetic out of scalarized JS locals, in order: an operation on literals
 * becomes its literal, and a multiply by one or zero, an add or subtract of zero and a divide by
 * one drop the identity (an identity matrix multiplied in leaves the other operand). A local that
 * folds to a literal or to another value is substituted into what reads it and dropped, unless
 * `kept` holds it (a value written out). Exact in JS: the same double arithmetic `compute` would
 * run, done once at compile time.
 */
export function foldScalarLocals(
  locals: readonly FXScalarLocal[],
  kept: ReadonlySet<string>,
): FXScalarLocal[] {
  const substitutes = new Map<string, FXExpr>();
  const folded: FXScalarLocal[] = [];
  for (const local of locals) {
    const expr = fold(
      replaceRefs(local.expr, (candidate) =>
        candidate.ref === "local" ? substitutes.get(candidate.name) : undefined,
      ),
    );
    if (!kept.has(local.name) && (expr.kind === "lit" || expr.kind === "ref")) {
      substitutes.set(local.name, expr);
    } else {
      folded.push({ name: local.name, expr });
    }
  }
  return folded;
}

/** `expr` with its constant arithmetic folded, bottom-up. */
function fold(expr: FXExpr): FXExpr {
  const children = childrenOf(expr);
  const node = children.length === 0 ? expr : withChildren(expr, children.map(fold));
  switch (node.kind) {
    case "bin":
      return foldBinary(node);
    case "un": {
      const value = scalarOf(node.a);
      return value === undefined ? node : lit(-value);
    }
    case "select": {
      const condition = scalarOf(node.cond);
      return condition === undefined ? node : condition !== 0 ? node.a : node.b;
    }
    case "lit":
    case "ref":
    case "call":
    case "swizzle":
    case "column":
    case "construct":
    case "raw":
      return node;
  }
}

function foldBinary(node: Extract<FXExpr, { kind: "bin" }>): FXExpr {
  const a = scalarOf(node.a);
  const b = scalarOf(node.b);
  if (a !== undefined && b !== undefined) {
    const value = evaluate(node.op, a, b);
    return value === undefined ? node : lit(value);
  }
  switch (node.op) {
    case "mul":
      if (a === 0 || b === 0) {
        return lit(0);
      }
      return a === 1 ? node.b : b === 1 ? node.a : node;
    case "add":
      return a === 0 ? node.b : b === 0 ? node.a : node;
    case "sub":
      return b === 0 ? node.a : node;
    case "div":
      return b === 1 ? node.a : node;
    case "mod":
    case "lt":
    case "le":
    case "gt":
    case "ge":
    case "eq":
      return node;
  }
}

/** `a op b` as `compute` would evaluate it; `undefined` for an operation left to it. */
function evaluate(
  op: Extract<FXExpr, { kind: "bin" }>["op"],
  a: number,
  b: number,
): number | undefined {
  switch (op) {
    case "add":
      return a + b;
    case "sub":
      return a - b;
    case "mul":
      return a * b;
    case "div":
      return a / b;
    case "lt":
      return a < b ? 1 : 0;
    case "le":
      return a <= b ? 1 : 0;
    case "gt":
      return a > b ? 1 : 0;
    case "ge":
      return a >= b ? 1 : 0;
    case "eq":
      return a === b ? 1 : 0;
    case "mod":
      return undefined;
  }
}

/** The number a scalar literal holds, or `undefined` for anything else. */
function scalarOf(expr: FXExpr): number | undefined {
  return expr.kind === "lit" && expr.values.length === 1 ? expr.values[0] : undefined;
}
