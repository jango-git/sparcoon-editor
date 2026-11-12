import { FX_AGE, FX_CORE_LIFECYCLE, FX_LIFETIME } from "sparcoon";

import { glslFloat } from "../core/codegen/printGLSL.Internal";
import type { FXValidatableOutput } from "../core/compiler/FXValidation.Internal";
import { FX_VALUE_TYPES } from "../core/socket/FXValueType";
import { bufferAccess } from "./FXKernelShared.Internal";

/**
 * The update's lifecycle epilogue for both tiers, kept in one place so JS and GLSL cannot drift.
 * The graph never writes `age`; it only binds the kill slot, and a kill sets
 * `age = max(age, lifetime)` - the dead state aging reaches, so everything that tells live from
 * dead treats it as an ordinary death. Aging by `dt` follows: in this epilogue on the GPU, in the
 * runtime (`advanceAges`) on JS.
 */

/** The update target's kill slot - the update sink's `kill` socket. */
export const FX_KILL_SLOT = "kill";

/** A kill value above this kills (the slot takes a 0/1 mask, like a collider's `contact`). */
export const FX_KILL_THRESHOLD = 0.5;

/** The kill slot as the binding validators see it: an optional float. */
export function killSlotOutput(slot: string): FXValidatableOutput {
  return { slot, type: FX_VALUE_TYPES.float, required: false };
}

/** The JS statement killing the current particle when `kill` (a float expression) says so. */
export function killStatementJS(kill: string): string {
  const age = bufferAccess(FX_CORE_LIFECYCLE, FX_AGE);
  const lifetime = bufferAccess(FX_CORE_LIFECYCLE, FX_LIFETIME);
  return `if (${kill} > ${FX_KILL_THRESHOLD.toString()}) { ${age} = Math.max(${age}, ${lifetime}); }`;
}

const COMPONENTS = ["x", "y", "z", "w"] as const;

/** The GLSL age after this update: killed when `kill` says so (if bound), then aged. */
export function agedLifecycleAgeGLSL(
  lifecycleIn: string,
  deltaTime: string,
  kill: string | undefined,
): string {
  const age = `${lifecycleIn}.${COMPONENTS[FX_AGE]}`;
  if (kill === undefined) {
    return `${age} + ${deltaTime}`;
  }
  const lifetime = `${lifecycleIn}.${COMPONENTS[FX_LIFETIME]}`;
  return `(${kill} > ${glslFloat(FX_KILL_THRESHOLD)} ? max(${age}, ${lifetime}) : ${age}) + ${deltaTime}`;
}
