import type { FXBinOp, FXExpr } from "../ir/FXExpr";
import type { FXFunctionDef } from "../ir/FXFunctions.Internal";
import type { FXRefResolver } from "./printGLSLBaseline.Internal";

/**
 * Mirrors `printGLSLBaseline` but only ever sees scalarized (float-only) trees - `scalarize` has
 * already split vectors, so a swizzle/construct/column reaching here is a bug and throws.
 */
export interface FXJSPrintResult {
  readonly code: string;
  /** Function helpers to emit once each, keyed by function name. */
  readonly helpers: ReadonlyMap<string, string>;
}

const REF_BY_NAME: FXRefResolver = (ref) => ref.name;

export function printJS(
  expression: FXExpr,
  functions: ReadonlyMap<string, FXFunctionDef>,
  resolveRef: FXRefResolver = REF_BY_NAME,
): FXJSPrintResult {
  const helpers = new Map<string, string>();

  const printMod = (a: string, b: string): string => {
    // JS `%` differs from GLSL mod on negatives; reuse the registry's helper.
    const definition = functions.get("mod");
    if (definition !== undefined) {
      if (definition.jsHelper !== undefined) {
        helpers.set("mod", definition.jsHelper);
      }
      return definition.js([a, b]);
    }
    return `(${a} - ${b} * Math.floor(${a} / ${b}))`;
  };

  const printBin = (op: FXBinOp, a: string, b: string): string => {
    switch (op) {
      case "add":
        return `(${a} + ${b})`;
      case "sub":
        return `(${a} - ${b})`;
      case "mul":
        return `(${a} * ${b})`;
      case "div":
        return `(${a} / ${b})`;
      case "mod":
        return printMod(a, b);
      case "lt":
        return `(${a} < ${b} ? 1 : 0)`;
      case "le":
        return `(${a} <= ${b} ? 1 : 0)`;
      case "gt":
        return `(${a} > ${b} ? 1 : 0)`;
      case "ge":
        return `(${a} >= ${b} ? 1 : 0)`;
      case "eq":
        return `(${a} === ${b} ? 1 : 0)`;
    }
  };

  const print = (node: FXExpr): string => {
    switch (node.kind) {
      case "lit":
        requireScalar(node, "literal");
        return String(node.values[0]);
      case "ref":
        requireScalar(node, "reference");
        return resolveRef(node);
      case "bin":
        return printBin(node.op, print(node.a), print(node.b));
      case "un":
        switch (node.op) {
          // FXUnOp has a single member today, making this case tautological - see the
          // fallthrough comment below for why the switch stays anyway.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          case "neg":
            // Space after `-` matters: `(--1)` is a `new Function` SyntaxError
            // (`--` decrements a non-lvalue).
            return `(- ${print(node.a)})`;
        }
      // The inner switch above is exhaustive over FXUnOp (single member today) and always
      // returns; a future member would fail to compile there, never reach here.
      // eslint-disable-next-line no-fallthrough
      case "call": {
        const definition = functions.get(node.fn);
        if (definition === undefined) {
          throw new Error(`sparcoon IR: unknown function "${node.fn}" in JS printer`);
        }
        const argumentStrings = node.args.map(print);
        if (definition.jsHelper !== undefined) {
          helpers.set(definition.name, definition.jsHelper);
        }
        return definition.js(argumentStrings);
      }
      case "select":
        return `(${print(node.cond)} !== 0 ? ${print(node.a)} : ${print(node.b)})`;
      case "swizzle":
      case "construct":
      case "column":
        throw new Error(`sparcoon IR: ${node.kind} reached the JS printer un-scalarized`);
      case "raw": {
        if (node.language !== "js") {
          throw new Error(`sparcoon IR: raw ${node.language} expression is not printable as JS`);
        }
        const dependencies = node.deps.map(print);
        return node.code.replace(/\$\d+/g, (token) => {
          const index = Number(token.slice(1));
          const dependency = dependencies[index];
          if (dependency === undefined) {
            throw new Error(
              `sparcoon IR: raw JS references ${token} but has ${dependencies.length} deps`,
            );
          }
          return dependency;
        });
      }
    }
  };

  return { code: print(expression), helpers };
}

function requireScalar(expression: FXExpr, what: string): void {
  if (expression.type.components !== 1) {
    throw new Error(`sparcoon IR: non-scalar ${what} reached the JS printer`);
  }
}
