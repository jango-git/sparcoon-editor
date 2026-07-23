import { FXCompilerErrorException } from "../compiler/FXCompilerError";
import type { FXBinOp, FXExpr } from "../ir/FXExpr";
import type { FXFunctionDef } from "../ir/FXFunctions.Internal";
import { isIntType } from "../socket/FXValueType";

/**
 * Resolves a `ref` to its printed access string; defaults to the name verbatim. A backend
 * passes a custom resolver for indirection, e.g. printing a `targetInput` as a buffer index.
 */
export type FXRefResolver = (ref: Extract<FXExpr, { kind: "ref" }>) => string;

const REF_BY_NAME: FXRefResolver = (ref) => ref.name;

/**
 * `FXExpr` -> GLSL source, plus function helpers pulled in. Trusts types (already checked by
 * `FXExprBuilder`) and only throws on what it structurally can't print (unknown fn, wrong-language `raw`).
 */
export interface FXGLSLPrintResult {
  readonly code: string;
  /** Function helpers to emit once each, keyed by function name. */
  readonly helpers: ReadonlyMap<string, string>;
}

/**
 * The baseline-tier (WebGL1/GLSL-ES-1.00) printer: reads a function's `glslBaseline`/
 * `glslBaselineHelper` fields. Independent implementation of `printGLSLStandard.Internal.ts`: the
 * baseline and standard tiers are fully separated outside the IR and the compilation core, so
 * there is no shared print core to keep in sync between the two.
 */
export function printGLSLBaseline(
  expression: FXExpr,
  functions: ReadonlyMap<string, FXFunctionDef>,
  resolveRef: FXRefResolver = REF_BY_NAME,
): FXGLSLPrintResult {
  const helpers = new Map<string, string>();

  const print = (node: FXExpr): string => {
    switch (node.kind) {
      case "lit": {
        const printLiteral = isIntType(node.type) ? glslInt : glslFloat;
        if (node.type.components !== 1) {
          return `${node.type.glslTypeName}(${node.values.map(printLiteral).join(", ")})`;
        }
        const value = node.values[0];
        if (value === undefined) {
          throw new Error("sparcoon IR: lit node has components 1 but an empty values array");
        }
        return printLiteral(value);
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
        if (definition.glslBaselineHelper !== undefined) {
          helpers.set(definition.name, definition.glslBaselineHelper);
        }
        if (typeof definition.glslBaseline === "function") {
          return definition.glslBaseline(argumentStrings);
        }
        const functionName =
          typeof definition.glslBaseline === "string" ? definition.glslBaseline : definition.name;
        return `${functionName}(${argumentStrings.join(", ")})`;
      }
      case "swizzle":
        return `(${print(node.a)}).${node.channels}`;
      case "column":
        // GLSL indexes a matrix natively; column `i` is a vecN.
        return `(${print(node.a)})[${node.index.toString()}]`;
      case "construct":
        return `${node.type.glslTypeName}(${node.args.map(print).join(", ")})`;
      case "select":
        return `(${print(node.cond)} != 0.0 ? ${print(node.a)} : ${print(node.b)})`;
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
      return `(${a} < ${b} ? 1.0 : 0.0)`;
    case "le":
      return `(${a} <= ${b} ? 1.0 : 0.0)`;
    case "gt":
      return `(${a} > ${b} ? 1.0 : 0.0)`;
    case "ge":
      return `(${a} >= ${b} ? 1.0 : 0.0)`;
    case "eq":
      return `(${a} == ${b} ? 1.0 : 0.0)`;
  }
}

/**
 * Non-finite has no GLSL spelling, so it throws (a custom node's `lit()` isn't `coerce`-guarded
 * like descriptor params are). Exponent-form numbers (`1e+21`) are already valid floats - skip the `.0`.
 */
export function glslFloat(value: number): string {
  if (!Number.isFinite(value)) {
    throw new FXCompilerErrorException({
      code: "glsl-float-not-finite",
      message: `sparcoon IR: non-finite number ${String(value)} cannot be printed as a GLSL literal`,
      params: { value: String(value) },
    });
  }
  const printed = String(value);
  if (printed.includes("e") || printed.includes("E")) {
    return printed;
  }
  return Number.isInteger(value) ? `${printed}.0` : printed;
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
