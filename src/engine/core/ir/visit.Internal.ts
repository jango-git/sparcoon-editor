import type { FXExpr, FXRefKind } from "./FXExpr";

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

/** Adds the name of every `kind` ref `expr` reads to `into`, and returns it. */
export function refNames(expr: FXExpr, kind: FXRefKind, into: Set<string>): Set<string> {
  if (expr.kind === "ref" && expr.ref === kind) {
    into.add(expr.name);
  }
  for (const child of childrenOf(expr)) {
    refNames(child, kind, into);
  }
  return into;
}

/** The names of every `kind` ref `exprs` read, each once. */
export function refNamesIn(exprs: Iterable<FXExpr>, kind: FXRefKind): string[] {
  const names = new Set<string>();
  for (const expr of exprs) {
    refNames(expr, kind, names);
  }
  return [...names];
}

/** `expr` with each ref `replace` maps to an expression swapped for it; other refs are kept. */
export function replaceRefs(
  expr: FXExpr,
  replace: (ref: Extract<FXExpr, { kind: "ref" }>) => FXExpr | undefined,
): FXExpr {
  if (expr.kind === "ref") {
    return replace(expr) ?? expr;
  }
  const children = childrenOf(expr);
  return children.length === 0
    ? expr
    : withChildren(
        expr,
        children.map((child) => replaceRefs(child, replace)),
      );
}
