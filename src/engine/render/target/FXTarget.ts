import type { FXShaderStage } from "../FXShaderStage";
import type { FXValueType } from "../../core/socket/FXValueType";
import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXRatePolicy } from "../../core/codegen/rates.Internal";

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
  /** How often its value changes (see {@link FXInputRate}) - what lets the compiler compute a
   *  fragment-stage value per vertex instead. Only the host knows it. */
  readonly rate: FXInputRate;
}

/**
 * How often a target input's value changes, slowest first:
 * - `draw`: once per draw call - a uniform (the clock, the camera, the emitter's motion);
 * - `primitive`: once per instanced primitive - a particle's own state, the same at all its
 *   vertices and fragments;
 * - `vertex`: per vertex, interpolated across the primitive (`p_uv`, the camera distance) - linear
 *   in between, so a nonlinear function of it is not;
 * - `fragment`: per fragment (the surface frame, normalized and faced per fragment).
 *
 * A fragment-stage value reading nothing faster than `primitive` is the same at every fragment of
 * a primitive, so the compiler may compute it per vertex and carry it across (see
 * `hoistToEarlyStage`).
 */
export type FXInputRate = "draw" | "primitive" | "vertex" | "fragment";

/** {@link FXInputRate} as the rank `classifyRates` joins over; rank 0 is a literal. */
export const FX_INPUT_RATE_RANK: Readonly<Record<FXInputRate, number>> = {
  draw: 1,
  primitive: 2,
  vertex: 3,
  fragment: 4,
};

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

/**
 * The rates a render graph compiled against `target` reads at: each target input at its declared
 * {@link FXInputRate}, a uniform once per draw. What the compiler cannot place - an impure call, a
 * `raw` not marked pure, anything else - is pinned at `fragment`, so nothing reading it moves.
 */
export function renderRatePolicy(
  target: FXTarget,
  isImpureCall: (fn: string) => boolean,
): FXRatePolicy {
  const rates = new Map(target.inputs.map((input) => [input.name, FX_INPUT_RATE_RANK[input.rate]]));
  const pinned = FX_INPUT_RATE_RANK.fragment;
  return {
    rateOfRef: (ref: Extract<FXExpr, { kind: "ref" }>): number => {
      switch (ref.ref) {
        case "targetInput":
          return rates.get(ref.name) ?? pinned;
        case "uniform":
          return FX_INPUT_RATE_RANK.draw;
        // A render graph reads no binding or attribute ref; a local one `classifyRates` resolves.
        case "local":
        case "binding":
        case "attribute":
          return pinned;
      }
    },
    isImpureCall,
    pinned,
  };
}
