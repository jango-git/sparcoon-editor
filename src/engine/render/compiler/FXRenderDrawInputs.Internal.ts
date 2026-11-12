import { FX_DRAW_INPUTS } from "sparcoon/editor";
import type { FXDrawStagePolicy } from "../../core/codegen/drawStage.Internal";
import { componentJS, CPU_TYPES, uniformValueJS } from "../../core/codegen/drawStage.Internal";

/**
 * What a render graph's draw stage reads on the CPU and how `compute` reads it: the runtime's draw
 * inputs (`FX_DRAW_INPUTS` - the clock, the pose, the object's motion) from `inputs`, and the
 * graph's numeric uniforms (its parameters) from the instance's `uniforms`.
 */
export const RENDER_DRAW_INPUTS: Pick<FXDrawStagePolicy, "readsOnCPU" | "printInput"> = {
  readsOnCPU: (ref) =>
    (ref.ref === "targetInput" && FX_DRAW_INPUTS.some((input) => input.name === ref.name)) ||
    (ref.ref === "uniform" && CPU_TYPES.has(ref.type.glslTypeName)),
  printInput: (kind, base, index) => {
    if (kind === "uniform") {
      return uniformValueJS(base, index);
    }
    const input = FX_DRAW_INPUTS.find((candidate) => candidate.name === base);
    if (kind !== "targetInput" || input === undefined) {
      throw new Error(`RENDER_DRAW_INPUTS: "${base}" is no draw input`);
    }
    return `inputs.${input.field}${componentJS(index)}`;
  },
};
