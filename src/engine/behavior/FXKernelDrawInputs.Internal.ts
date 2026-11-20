import type { FXKernelDrawInputs } from "sparcoon";

import type { FXDrawStagePolicy } from "../core/codegen/drawStage.Internal";
import { componentJS, uniformValueJS } from "../core/codegen/drawStage.Internal";
import type { FXRatePolicy } from "../core/codegen/rates.Internal";
import { isImpureFunction } from "../core/ir/FXFunctions.Internal";
import { isInvariantKernelRef, targetInputOf } from "./FXKernelRefResolve.Internal";
import type {
  FXKernelHostParameter,
  FXKernelHostValue,
  FXKernelTarget,
} from "./FXParticleBehaviorTarget";

/** A GPU kernel's rate ranks: a literal, what is one for the whole pass, what varies by particle. */
export const KERNEL_RATE = { constant: 0, pass: 1, particle: 2 } as const;

/**
 * Rates of a phase's values. One per pass: bindings, the timestep, the emitter pose and motion, the
 * births' inherited values. Per particle: state, index, impure calls (`rand`), a spawn's pose at
 * birth (isInvariantKernelRef).
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

const PARAMETER_FIELDS: Readonly<
  Record<FXKernelHostParameter, keyof FXKernelDrawInputs | undefined>
> = { dt: "deltaTime", seed: undefined };

function passInputField(host: FXKernelHostValue | undefined): keyof FXKernelDrawInputs | undefined {
  switch (host?.kind) {
    case "parameter":
      return PARAMETER_FIELDS[host.parameter];
    case "emitter":
      return host.field;
    case "particleIndex":
    case undefined:
      return undefined;
  }
}

/**
 * What a GPU kernel's draw stage reads on the CPU and how `compute` reads it: the pass's timestep
 * and the emitter's pose and motion from `inputs` (an `FXKernelDrawInputs`), the bindings (its
 * parameters) from the emitter's own `uniforms`.
 */
export function kernelDrawInputs(
  target: FXKernelTarget,
): Pick<FXDrawStagePolicy, "readsOnCPU" | "printInput"> {
  return {
    // A pass-invariant value `inputs` does not carry - what a pass's births inherit, the seed -
    // stays a read of the GPU's own uniform.
    readsOnCPU: (ref): boolean =>
      (ref.ref === "binding" && ref.type.glslTypeName === "float") ||
      (ref.ref === "targetInput" &&
        isInvariantKernelRef(target, ref) &&
        passInputField(targetInputOf(target, ref.name).input?.host) !== undefined),
    printInput: (kind, base, index): string => {
      if (kind === "binding") {
        return uniformValueJS(base, index);
      }
      const field =
        kind === "targetInput"
          ? passInputField(targetInputOf(target, base).input?.host)
          : undefined;
      if (field === undefined) {
        throw new Error(`kernelDrawInputs: "${base}" is no pass input`);
      }
      return `inputs.${field}${componentJS(index)}`;
    },
  };
}
