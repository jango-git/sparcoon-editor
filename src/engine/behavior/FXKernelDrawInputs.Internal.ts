import type { FXKernelDrawInputs } from "sparcoon";
import type { FXDrawStagePolicy } from "../core/codegen/drawStage.Internal";
import { componentJS, uniformValueJS } from "../core/codegen/drawStage.Internal";
import type { FXRatePolicy } from "../core/codegen/rates.Internal";
import { isImpureFunction } from "../core/ir/FXFunctions.Internal";
import type { FXKernelTarget } from "./FXParticleBehaviorTarget";
import { FX_EMITTER_INPUT_FIELD } from "./FXParticleBehaviorTarget";
import { isInvariantKernelRef } from "./FXKernelRefResolve.Internal";

/** A GPU kernel's rate ranks: a literal, what is one for the whole pass, what varies by particle. */
export const KERNEL_RATE = { constant: 0, pass: 1, particle: 2 } as const;

/**
 * The rates of a GPU kernel phase's values against `target`: a binding (a parameter), the
 * timestep and the emitter's pose and motion are one for the whole pass; a particle's state, its
 * index, an impure call (`rand`) vary by particle.
 */
export function kernelRatePolicy(target: FXKernelTarget): FXRatePolicy {
  return {
    rateOfRef: (ref): number => {
      switch (ref.ref) {
        case "binding":
        case "uniform":
          return KERNEL_RATE.pass;
        case "targetInput":
          return isInvariantKernelRef(target, ref) ? KERNEL_RATE.pass : KERNEL_RATE.particle;
        case "local":
        case "attribute":
          return KERNEL_RATE.particle;
      }
    },
    isImpureCall: isImpureFunction,
    pinned: KERNEL_RATE.particle,
  };
}

/** The `FXKernelDrawInputs` field each pass-invariant target input is read from. */
const PASS_INPUT_FIELD: Readonly<Partial<Record<string, keyof FXKernelDrawInputs>>> = {
  dt: "deltaTime",
  ...FX_EMITTER_INPUT_FIELD,
};

/**
 * What a GPU kernel's draw stage reads on the CPU and how `compute` reads it: the pass's timestep
 * and the emitter's pose and motion from `inputs` (an `FXKernelDrawInputs`), the bindings (its
 * parameters) from the emitter's own `uniforms`.
 */
export function kernelDrawInputs(
  target: FXKernelTarget,
): Pick<FXDrawStagePolicy, "readsOnCPU" | "printInput"> {
  return {
    readsOnCPU: (ref): boolean =>
      (ref.ref === "binding" && ref.type.glslTypeName === "float") ||
      (ref.ref === "targetInput" && isInvariantKernelRef(target, ref)),
    printInput: (kind, base, index): string => {
      if (kind === "binding") {
        return uniformValueJS(base, index);
      }
      const field = kind === "targetInput" ? PASS_INPUT_FIELD[base] : undefined;
      if (field === undefined) {
        throw new Error(`kernelDrawInputs: "${base}" is no pass input`);
      }
      return `inputs.${field}${componentJS(index)}`;
    },
  };
}
