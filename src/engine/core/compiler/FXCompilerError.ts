/** Machine-readable classification of a graph validation/compilation failure. */
export type FXCompilerErrorCode =
  | "cycle"
  | "missing-required-input"
  | "type-mismatch"
  | "missing-required-output"
  | "unknown-node"
  | "unknown-socket"
  | "unknown-output-slot"
  | "duplicate-output-binding"
  | "duplicate-input-connection"
  | "cross-phase-dependency"
  | "overlapping-output-slots"
  | "attribute-type-conflict"
  | "undeclared-attribute"
  | "generic-type-conflict"
  | "generic-type-unresolved"
  | "unknown-target-input"
  | "target-input-stage-mismatch"
  | "bad-target-buffer-identifier"
  | "duplicate-target-buffer"
  | "bad-target-buffer-stride"
  | "undeclared-target-buffer"
  | "bad-target-offset"
  | "target-offset-out-of-bounds"
  | "bad-target-input-identifier"
  | "duplicate-target-input"
  | "spawn-input-has-dt"
  | "dt-input-has-offsets"
  | "target-input-offset-count-mismatch"
  | "offsetless-input-not-reserved"
  | "duplicate-target-output"
  | "target-output-offset-count-mismatch"
  | "duplicate-output-offset-write"
  | "duplicate-integration-offset-write"
  | "integration-ref-not-target-input"
  | "integration-ref-not-scalar"
  | "integration-reads-dt-in-spawn"
  | "integration-input-not-declared"
  | "phase-buffer-not-in-update"
  | "phase-buffer-stride-mismatch"
  | "bad-behavior-targets-shape"
  | "unresolvable-target-input"
  | "malformed-target-shape"
  | "unknown-target-value-type"
  | "bad-render-input-identifier"
  | "render-input-is-glsl-keyword"
  | "render-input-matches-generated-pattern"
  | "unknown-render-input-stage"
  | "unknown-render-output-stage"
  | "stage-direction-mismatch"
  | "unknown-render-stage"
  | "stage-input-mismatch"
  | "stage-output-mismatch"
  | "opaque-type-crosses-stage"
  | "varying-from-fragment-stage"
  | "phase-not-supported"
  | "unknown-node-type"
  | "unsupported-snapshot-version"
  | "bad-param"
  | "bad-param-stage"
  | "bad-param-phase"
  | "param-uniform-type-conflict"
  | "bad-structural-param-value"
  | "structural-param-immutable"
  | "bad-finite-number"
  | "bad-finite-number-range"
  | "bad-finite-vector"
  | "bad-finite-scalar-or-vector"
  | "bad-curve-value"
  | "bad-curve-point"
  | "bad-curve-interpolation"
  | "bad-gradient-value"
  | "empty-gradient"
  | "bad-gradient-stop"
  | "bad-enum-value"
  | "bad-flag-value"
  | "bad-node-stage"
  | "bad-node-phase"
  | "bad-attribute-name"
  | "reconcile-failed"
  | "compile-failed"
  | "ir-matrix-mul-dimension-mismatch"
  | "ir-matrix-vector-mul-width-mismatch"
  | "ir-vector-matrix-mul-width-mismatch"
  | "ir-matrix-mul-unsupported"
  | "ir-matrix-add-sub-mismatch"
  | "ir-matrix-op-unsupported"
  | "ir-arithmetic-bad-operand-type"
  | "ir-mod-int-unsupported"
  | "ir-arithmetic-no-left-splat"
  | "ir-arithmetic-type-mismatch"
  | "ir-comparison-bad-operand-type"
  | "ir-int-literal-not-integer"
  | "ir-vector-literal-bad-width"
  | "ir-negate-bad-operand"
  | "ir-unknown-function"
  | "ir-no-matching-overload"
  | "ir-swizzle-bad-channel-count"
  | "ir-swizzle-bad-source"
  | "ir-swizzle-unknown-channel"
  | "ir-swizzle-channel-out-of-range"
  | "ir-column-bad-source"
  | "ir-column-index-out-of-range"
  | "ir-construct-bad-target-type"
  | "ir-construct-bad-argument-type"
  | "ir-construct-component-count-mismatch"
  | "ir-construct-matrix-bad-form"
  | "ir-no-implicit-int-float-conversion"
  | "ir-bad-numeric-conversion"
  | "ir-to-int-bad-operand"
  | "ir-to-float-bad-operand"
  | "ir-select-condition-not-float"
  | "ir-select-branch-type-mismatch"
  | "ir-bad-vector-width"
  | "node-factory-type-mismatch"
  | "unhandled-blend-mode"
  | "glsl-float-not-finite"
  | "glsl-int-not-finite"
  | "output-not-produced"
  | "validate-failed"
  | "hash-failed"
  | "rebind-failed"
  | "disposed";

/** A single, editor-presentable problem found in a graph. */
export interface FXCompilerError {
  readonly code: FXCompilerErrorCode;
  readonly message: string;
  /** Node the error is attributed to, when applicable. */
  readonly nodeId?: string;
  /** Socket the error is attributed to, when applicable. */
  readonly socketKey?: string;
  /** Target output slot the error is attributed to, when applicable. */
  readonly slot?: string;
  /** Named values `message` interpolated into English text - the localized-message resolver
   *  re-interpolates these into a translated template instead; absent until migrated. */
  readonly params?: Record<string, string | number>;
}

/**
 * A throwable carrier of an {@link FXCompilerError}. A few throw-based paths (snapshot reconcile,
 * target reads) use this so a non-throwing boundary can fold it into a structured `invalid` result.
 */
export class FXCompilerErrorException extends Error {
  /** The structured error payload, ready to surface to the editor. */
  public readonly error: FXCompilerError;

  constructor(error: FXCompilerError) {
    super(error.message);
    this.name = "FXCompilerErrorException";
    this.error = error;
  }
}

/** Whether `value` is an {@link FXCompilerErrorException}. */
export function isFXCompilerErrorException(value: unknown): value is FXCompilerErrorException {
  return value instanceof FXCompilerErrorException;
}

/** Outcome of {@link FXCompilerBaseline.validate}; collects every error, never throws. */
export interface FXValidationResult {
  readonly ok: boolean;
  readonly errors: readonly FXCompilerError[];
}
