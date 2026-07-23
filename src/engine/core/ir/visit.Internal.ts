import type { FXExpr } from "./FXExpr";

/**
 * Structural traversal of the {@link FXExpr} IR: the per-kind child map that CSE, target-signature
 * encoding, and ref collection all share, so a new IR kind only needs updating here (plus printers).
 */

/** Child subexpressions of `expr`, in a canonical order. */
export function childrenOf(expr: FXExpr): readonly FXExpr[] {
  switch (expr.kind) {
    case "lit":
    case "ref":
      return [];
    case "bin":
      return [expr.a, expr.b];
    case "un":
      return [expr.a];
    case "call":
      return expr.args;
    case "swizzle":
      return [expr.a];
    case "column":
      return [expr.a];
    case "construct":
      return expr.args;
    case "select":
      return [expr.cond, expr.a, expr.b];
    case "raw":
      return expr.deps;
  }
}

/** Rebuilds `expr` with its children replaced by `children` (same canonical order as {@link childrenOf}). */
export function withChildren(expr: FXExpr, children: readonly FXExpr[]): FXExpr {
  switch (expr.kind) {
    case "lit":
    case "ref":
      return expr;
    case "bin":
      return { ...expr, a: childAt(children, 0), b: childAt(children, 1) };
    case "un":
      return { ...expr, a: childAt(children, 0) };
    case "call":
      return { ...expr, args: children };
    case "swizzle":
      return { ...expr, a: childAt(children, 0) };
    case "column":
      return { ...expr, a: childAt(children, 0) };
    case "construct":
      return { ...expr, args: children };
    case "select":
      return {
        ...expr,
        cond: childAt(children, 0),
        a: childAt(children, 1),
        b: childAt(children, 2),
      };
    case "raw":
      return { ...expr, deps: children };
  }
}

/** Indexes a same-order `children` array at a position {@link childrenOf}'s count guarantees is in range. */
export function childAt(children: readonly FXExpr[], index: number): FXExpr {
  const child = children[index];
  if (child === undefined) {
    throw new Error(
      `sparcoon IR: child index ${index.toString()} out of range (length ${children.length.toString()})`,
    );
  }
  return child;
}
