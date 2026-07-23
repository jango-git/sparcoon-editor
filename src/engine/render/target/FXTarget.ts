import type { FXShaderStage } from "../FXShaderStage";
import type { FXValueType } from "../../core/socket/FXValueType";

/**
 * A value the host makes available to the graph (a "builtin"): particle age, uv,
 * view position, etc. Nodes reference these by name through the compiler context.
 */
export interface FXTargetInput {
  /** GLSL identifier as it appears in the host shader (e.g. `"p_uv"`). */
  readonly name: string;
  readonly type: FXValueType;
  /** Stages in which this input is legal to read (a builtin may span both). */
  readonly stages: readonly FXShaderStage[];
}

/**
 * An output slot the host expects the graph to fill (e.g. `albedo`, `normal`,
 * `emission`). Validation fails if a `required` slot is left unbound.
 */
export interface FXTargetOutput {
  readonly slot: string;
  readonly type: FXValueType;
  readonly stage: FXShaderStage;
  readonly required: boolean;
}

/**
 * The contract between a compiled graph and a concrete host material. This is the
 * key abstraction that lets one graph/compiler serve both the particle materials
 * and external VFX meshes: each host is just a different {@link FXTarget}.
 *
 * The compiler validates a graph against a target and produces an
 * {@link FXCompiledShader}; the target's inputs/outputs define what is legal.
 */
export interface FXTarget {
  readonly name: string;
  readonly inputs: readonly FXTargetInput[];
  readonly outputs: readonly FXTargetOutput[];
}
