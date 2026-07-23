import type { FXExpr } from "../ir/FXExpr";
import { childAt, childrenOf, withChildren } from "../ir/visit.Internal";

/**
 * CSE over a phase's scalarized JS-backend locals (GLSL prints vectors directly and its own
 * driver handles CSE). `raw` nodes are never merged, so distinct `Math.random()` draws stay
 * distinct; a `call` to an impure function (`isImpureCall`, currently only `rand`) gets the same
 * treatment - unlike `raw`, an impure call can otherwise look identical to every other call of the
 * same function (same name, same - possibly zero - args), so it needs an explicit check rather
 * than falling out of the node kind alone.
 */
export interface FXScalarLocal {
  readonly name: string;
  readonly expr: FXExpr;
}

/**
 * Compute-bearing nodes are worth extracting (`lit`/`ref` are already cheap). Exhaustive
 * switch so a new IR kind must be classified here, not silently default to non-extractable.
 */
function isExtractable(expression: FXExpr, isImpureCall: (fn: string) => boolean): boolean {
  switch (expression.kind) {
    case "call":
      return !isImpureCall(expression.fn);
    case "bin":
    case "un":
    case "select":
    case "swizzle":
    case "column":
      return true;
    case "lit":
    case "ref":
    case "construct":
    case "raw":
      return false;
  }
}

/** Extracts subtrees used 2+ times into named locals; output stays topologically ordered. */
export function commonSubexpressionElimination(
  locals: readonly FXScalarLocal[],
  allocName: (hint: string) => string,
  isImpureCall: (fn: string) => boolean,
): FXScalarLocal[] {
  // 1. Hash-cons: identical subtrees become one shared object; `raw` stays unique.
  const table = new Map<string, FXExpr>();
  const identifiers = new Map<FXExpr, number>();
  let nextIdentifier = 0;
  const identifier = (expression: FXExpr): number => identifiers.get(expression) as number;
  const register = (node: FXExpr, key: string | undefined): FXExpr => {
    if (key !== undefined) {
      const hit = table.get(key);
      if (hit !== undefined) {
        return hit;
      }
      table.set(key, node);
    }
    identifiers.set(node, nextIdentifier);
    nextIdentifier += 1;
    return node;
  };
  const intern = (expression: FXExpr): FXExpr => {
    const children = childrenOf(expression).map(intern);
    const node = withChildren(expression, children);
    const typeId = expression.type.id;
    switch (expression.kind) {
      case "raw":
        return register(node, undefined); // never deduped: preserves Math.random() distinctness
      case "lit":
        return register(node, `lit:${typeId}:${expression.values.join(",")}`);
      case "ref":
        return register(node, `ref:${expression.ref}:${expression.name}:${typeId}`);
      case "bin":
        return register(
          node,
          `bin:${expression.op}:${typeId}:${identifier(childAt(children, 0))},${identifier(childAt(children, 1))}`,
        );
      case "un":
        return register(node, `un:${expression.op}:${typeId}:${identifier(childAt(children, 0))}`);
      case "call":
        // An impure call (rand) never dedupes, same reasoning as `raw` above - every call site
        // is an independent draw, even a zero-arg one that would otherwise hash identically.
        return isImpureCall(expression.fn)
          ? register(node, undefined)
          : register(node, `call:${expression.fn}:${typeId}:${children.map(identifier).join(",")}`);
      case "swizzle":
        return register(
          node,
          `sw:${expression.channels}:${typeId}:${identifier(childAt(children, 0))}`,
        );
      case "column":
        return register(
          node,
          `col:${expression.index.toString()}:${typeId}:${identifier(childAt(children, 0))}`,
        );
      case "construct":
        return register(node, `con:${typeId}:${children.map(identifier).join(",")}`);
      case "select":
        return register(
          node,
          `sel:${typeId}:${identifier(childAt(children, 0))},${identifier(childAt(children, 1))},${identifier(childAt(children, 2))}`,
        );
    }
  };
  const roots = locals.map((local) => ({ name: local.name, node: intern(local.expr) }));

  // 2. Reference counts: how many distinct emitted-once parents point at each node.
  const referenceCount = new Map<FXExpr, number>();
  const seen = new Set<FXExpr>();
  const bump = (expression: FXExpr): void => {
    referenceCount.set(expression, (referenceCount.get(expression) ?? 0) + 1);
  };
  const visit = (expression: FXExpr): void => {
    if (seen.has(expression)) {
      return;
    }
    seen.add(expression);
    for (const child of childrenOf(expression)) {
      bump(child);
      visit(child);
    }
  };
  for (const root of roots) {
    bump(root.node);
    visit(root.node);
  }

  // 3. Extraction set: shared, compute-bearing, and not itself a plan root (roots keep names).
  const rootObjects = new Set(roots.map((root) => root.node));
  const extractedName = new Map<FXExpr, string>();
  for (const [node, count] of referenceCount) {
    if (count >= 2 && isExtractable(node, isImpureCall) && !rootObjects.has(node)) {
      extractedName.set(node, allocName("cse"));
    }
  }

  // 4. Emit topologically: an extracted node is materialized just before its first use.
  const output: FXScalarLocal[] = [];
  const emitted = new Set<FXExpr>();
  const rebuild = (expression: FXExpr): FXExpr => {
    const children = childrenOf(expression).map((child) => {
      const name = extractedName.get(child);
      if (name !== undefined) {
        ensure(child);
        return { kind: "ref", type: child.type, ref: "local", name } satisfies FXExpr;
      }
      return rebuild(child);
    });
    return withChildren(expression, children);
  };
  function ensure(node: FXExpr): void {
    if (emitted.has(node)) {
      return;
    }
    emitted.add(node);
    const expr = rebuild(node); // ensures extracted descendants first, so deps precede this node
    output.push({ name: extractedName.get(node) as string, expr });
  }
  for (const root of roots) {
    output.push({ name: root.name, expr: rebuild(root.node) });
  }
  return output;
}

/**
 * Splits `locals` into per-particle-invariant (hoistable out of the loop, computed once) and
 * variant, bottom-up: `raw` is conservatively variant (may be `Math.random()`); an impure call
 * (`isImpureCall`, currently only `rand`) is variant too and for the same reason - a zero-arg
 * impure call would otherwise vacuously pass "all children are invariant" (it has none) and get
 * wrongly hoisted to compute once for the whole burst instead of once per particle. Everything
 * else is invariant iff its children are. Order is preserved within each partition.
 */
export function partitionByInvariance(
  locals: readonly FXScalarLocal[],
  isInvariantRef: (ref: Extract<FXExpr, { kind: "ref" }>) => boolean,
  isImpureCall: (fn: string) => boolean,
): { preLoop: FXScalarLocal[]; body: FXScalarLocal[] } {
  const localInvariant = new Map<string, boolean>();
  const isInvariant = (expression: FXExpr): boolean => {
    switch (expression.kind) {
      case "lit":
        return true;
      case "raw":
        return false;
      case "ref":
        return expression.ref === "local"
          ? (localInvariant.get(expression.name) ?? false)
          : isInvariantRef(expression);
      case "call":
        return !isImpureCall(expression.fn) && childrenOf(expression).every(isInvariant);
      // Invariant iff all children are. Enumerated (not `default`) so a new impure kind can't
      // silently inherit this rule and get wrongly hoisted out of the per-particle loop.
      case "bin":
      case "un":
      case "swizzle":
      case "column":
      case "construct":
      case "select":
        return childrenOf(expression).every(isInvariant);
    }
  };
  const preLoop: FXScalarLocal[] = [];
  const body: FXScalarLocal[] = [];
  for (const local of locals) {
    const invariant = isInvariant(local.expr);
    localInvariant.set(local.name, invariant);
    (invariant ? preLoop : body).push(local);
  }
  return { preLoop, body };
}
