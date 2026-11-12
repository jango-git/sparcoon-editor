import { FXCompilerErrorException } from "../compiler/FXCompilerError";
import type { FXBinOp, FXExpr } from "../ir/FXExpr";
import type { FXFunctionDef } from "../ir/FXFunctions.Internal";
import { collectHelper } from "../ir/FXHelperModule.Internal";
import { isIntType } from "../socket/FXValueType";
import { shortestFloat32 } from "./float32.Internal";

/**
 * Resolves a `ref` to its printed access string; defaults to the name verbatim. A backend
 * passes a custom resolver for indirection, e.g. printing a `targetInput` as a buffer index.
 */
export type FXRefResolver = (ref: Extract<FXExpr, { kind: "ref" }>) => string;

export const REF_BY_NAME: FXRefResolver = (ref) => ref.name;

/**
 * `FXExpr` -> GLSL source, plus function helpers pulled in. Trusts types (already checked by
 * `FXExprBuilder`) and only throws on what it structurally can't print (unknown fn, wrong-language `raw`).
 */
export interface FXGLSLPrintResult {
  readonly code: string;
  /** Helpers to emit once each, dependencies first (see `collectHelper`). */
  readonly helpers: ReadonlyMap<string, string>;
}

/** How a tier spells a function: its GLSL name or printer, and the helper it needs, if any. */
export interface FXGLSLSpelling {
  readonly spelling: FXFunctionDef["glslBaseline"];
  readonly helper: FXFunctionDef["glslBaselineHelper"];
}

/**
 * `expression` as GLSL, for a tier that spells each function by `spellingOf` - the one thing the
 * tiers' printers differ in; the rest (literals, operators, swizzles, `raw`) is the language both
 * GLSL versions share.
 */
export function printGLSL(
  expression: FXExpr,
  functions: ReadonlyMap<string, FXFunctionDef>,
  resolveRef: FXRefResolver,
  spellingOf: (definition: FXFunctionDef) => FXGLSLSpelling,
): FXGLSLPrintResult {
  const helpers = new Map<string, string>();

  const print = (node: FXExpr): string => {
    switch (node.kind) {
      case "lit": {
        const printLiteral = isIntType(node.type) ? glslInt : glslFloat;
        if (node.type.components !== 1) {
          return `${node.type.glslTypeName}(${node.values.map(printLiteral).join(", ")})`;
        }
        const [scalarValue] = node.values;
        if (scalarValue === undefined) {
          throw new Error("sparcoon IR: scalar literal has no value component");
        }
        return printLiteral(scalarValue);
      }
      case "ref":
        return resolveRef(node);
      case "bin":
        return printBin(node.op, print(node.a), print(node.b));
      case "un":
        switch (node.op) {
          // FXUnOp has a single member today, making this case tautological - see the
          // fallthrough comment below for why the switch stays anyway.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          case "neg":
            // Space after `-` matters: `(--1.0)` is a GLSL parse error.
            return `(- ${print(node.a)})`;
        }
      // The inner switch above is exhaustive over FXUnOp (single member today) and always
      // returns; a future member would fail to compile there, never reach here.
      // eslint-disable-next-line no-fallthrough
      case "call": {
        const definition = functions.get(node.fn);
        if (definition === undefined) {
          throw new Error(`sparcoon IR: unknown function "${node.fn}" in GLSL printer`);
        }
        const argumentStrings = node.args.map(print);
        const { spelling, helper } = spellingOf(definition);
        if (helper !== undefined) {
          collectHelper(helpers, definition.name, helper);
        }
        if (typeof spelling === "function") {
          return spelling(argumentStrings);
        }
        const functionName = typeof spelling === "string" ? spelling : definition.name;
        return `${functionName}(${argumentStrings.join(", ")})`;
      }
      case "swizzle":
        return `(${print(node.a)}).${node.channels}`;
      case "column":
        // GLSL indexes a matrix natively; column `i` is a vecN.
        return `(${print(node.a)})[${node.index.toString()}]`;
      case "construct":
        return `${node.type.glslTypeName}(${node.args.map(print).join(", ")})`;
      case "select": {
        // A comparison is a 1.0/0.0 float in the IR; as a select's condition it reads as the
        // bool it already is.
        const cond =
          node.cond.kind === "bin" && isComparison(node.cond.op)
            ? `${print(node.cond.a)} ${COMPARISON_OPERATORS[node.cond.op]} ${print(node.cond.b)}`
            : `${print(node.cond)} != 0.0`;
        return `(${cond} ? ${print(node.a)} : ${print(node.b)})`;
      }
      case "raw": {
        if (node.language !== "glsl") {
          throw new Error(`sparcoon IR: raw ${node.language} expression is not printable as GLSL`);
        }
        const dependencies = node.deps.map(print);
        return node.code.replace(/\$\d+/g, (token) => {
          const index = Number(token.slice(1));
          const dependency = dependencies[index];
          if (dependency === undefined) {
            throw new Error(
              `sparcoon IR: raw GLSL references ${token} but has ${dependencies.length} deps`,
            );
          }
          return dependency;
        });
      }
    }
  };

  return { code: print(expression), helpers };
}

function printBin(op: FXBinOp, a: string, b: string): string {
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
      return `mod(${a}, ${b})`;
    case "lt":
    case "le":
    case "gt":
    case "ge":
    case "eq":
      return `(${a} ${COMPARISON_OPERATORS[op]} ${b} ? 1.0 : 0.0)`;
  }
}

type FXComparisonOp = "lt" | "le" | "gt" | "ge" | "eq";

/** The GLSL operator of each (scalar) comparison. */
const COMPARISON_OPERATORS: Readonly<Record<FXComparisonOp, string>> = {
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
  eq: "==",
};

function isComparison(op: FXBinOp): op is FXComparisonOp {
  return Object.hasOwn(COMPARISON_OPERATORS, op);
}

/**
 * Non-finite has no GLSL spelling, so it throws (a custom node's `lit()` isn't `coerce`-guarded
 * like descriptor params are). Exponent-form numbers (`1e+21`) are already valid floats - skip the `.0`.
 * Spelled as the GPU holds it (see `shortestFloat32`).
 */
export function glslFloat(value: number): string {
  if (!Number.isFinite(value)) {
    throw new FXCompilerErrorException({
      code: "glsl-float-not-finite",
      message: `sparcoon IR: non-finite number ${String(value)} cannot be printed as a GLSL literal`,
      params: { value: String(value) },
    });
  }
  const printed = shortestFloat32(value);
  if (printed.includes("e") || printed.includes("E")) {
    return printed;
  }
  return printed.includes(".") ? printed : `${printed}.0`;
}

/** Prints an `int`-family literal component - no decimal point, never exponent form. */
export function glslInt(value: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new FXCompilerErrorException({
      code: "glsl-int-not-finite",
      message: `sparcoon IR: ${String(value)} cannot be printed as a GLSL int literal (not a finite integer)`,
      params: { value: String(value) },
    });
  }
  return String(value);
}
