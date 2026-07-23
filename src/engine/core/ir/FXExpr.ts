import type { FXValueType } from "../socket/FXValueType";

/**
 * A node of sparcoon's backend-neutral IR. Immutable once built - only `FXExprBuilder`'s
 * builders construct one and enforce type rules; printers trust the tree without re-checking.
 */
export type FXExpr =
  /** A literal: one component for a scalar, N for a vector. */
  | { readonly kind: "lit"; readonly type: FXValueType; readonly values: readonly number[] }
  /** A reference to a named value; how it prints depends on {@link FXRefKind}. */
  | {
      readonly kind: "ref";
      readonly type: FXValueType;
      readonly ref: FXRefKind;
      readonly name: string;
    }
  | {
      readonly kind: "bin";
      readonly type: FXValueType;
      readonly op: FXBinOp;
      readonly a: FXExpr;
      readonly b: FXExpr;
    }
  | { readonly kind: "un"; readonly type: FXValueType; readonly op: FXUnOp; readonly a: FXExpr }
  /** A call into the function registry (`sin`, `mix`, `length`, ...). */
  | {
      readonly kind: "call";
      readonly type: FXValueType;
      readonly fn: string;
      readonly args: readonly FXExpr[];
    }
  /** Component selection/reorder; `channels` is `"x"`..`"wzyx"`. */
  | {
      readonly kind: "swizzle";
      readonly type: FXValueType;
      readonly a: FXExpr;
      readonly channels: string;
    }
  /** Column extraction: the `index`-th column of a `matN`, as a `vecN` (column-major, `m[i]`). */
  | {
      readonly kind: "column";
      readonly type: FXValueType;
      readonly a: FXExpr;
      readonly index: number;
    }
  /** Assembles a `vecN` from scalars and/or shorter vectors. */
  | { readonly kind: "construct"; readonly type: FXValueType; readonly args: readonly FXExpr[] }
  /** Branchless select: `cond ? a : b`, both branches evaluated by value. */
  | {
      readonly kind: "select";
      readonly type: FXValueType;
      readonly cond: FXExpr;
      readonly a: FXExpr;
      readonly b: FXExpr;
    }
  /**
   * Escape hatch for code the IR can't express; `deps` substitute into `code` as `$0`, `$1`, ...
   * The author owns `type`/`language` - the mismatched-language backend throws rather than print it.
   */
  | {
      readonly kind: "raw";
      readonly type: FXValueType;
      readonly language: "glsl" | "js";
      readonly code: string;
      readonly deps: readonly FXExpr[];
    };

/** Binary operators. Arithmetic returns `T`; comparisons return `float` (0/1). */
export type FXBinOp = "add" | "sub" | "mul" | "div" | "mod" | "lt" | "le" | "gt" | "ge" | "eq";

export type FXUnOp = "neg";

/**
 * Where a {@link FXExpr} reference draws its value from. A `local`'s name is CSE-generated
 * (SSA-style); `uniform`/`binding`/`targetInput`/`attribute` resolve via the backend's ref resolver.
 */
export type FXRefKind = "local" | "uniform" | "binding" | "targetInput" | "attribute";
