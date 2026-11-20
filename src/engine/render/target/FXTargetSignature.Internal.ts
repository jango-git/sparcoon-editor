import { byJSON } from "../../core/compiler/targetLint.Internal";
import type { FXTarget } from "./FXTarget";

/**
 * Order-independent string of the target's whole shape, hashed so a re-shaped target recompiles.
 */
export function renderTargetSignature(target: FXTarget): string {
  const inputs = target.inputs
    .map((input) => [input.name, input.type.id, [...input.stages].sort(), input.rate])
    .sort(byJSON);
  const outputs = target.outputs
    .map((output) => [
      output.slot,
      output.type.id,
      output.stage,
      output.required,
      output.shadowOnly === true,
    ])
    .sort(byJSON);
  const shadow = (target.shadow ?? [])
    .map((output) => [output.slot, output.from, output.channels ?? "", output.unless ?? ""])
    .sort(byJSON);
  return JSON.stringify(["render", target.name, inputs, outputs, shadow]);
}
