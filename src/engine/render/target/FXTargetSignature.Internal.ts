import { byJSON } from "../../core/compiler/targetLint.Internal";
import type { FXTarget } from "./FXTarget";

/** A canonical, order-independent string capturing a render {@link FXTarget}'s whole shape. Fed
 *  to the structural hash in place of the bare name, so a host that edits its target contract
 *  without renaming still forces a recompile instead of rebinding a stale artifact. */
export function renderTargetSignature(target: FXTarget): string {
  const inputs = target.inputs
    .map((input) => [input.name, input.type.id, [...input.stages].sort()])
    .sort(byJSON);
  const outputs = target.outputs
    .map((output) => [output.slot, output.type.id, output.stage, output.required])
    .sort(byJSON);
  return JSON.stringify(["render", target.name, inputs, outputs]);
}
