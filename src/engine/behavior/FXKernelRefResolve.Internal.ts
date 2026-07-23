/**
 * Resolves kernel refs (locals/bindings/target-inputs) to their JS access strings, and the
 * loop-invariance policy that decides what {@link FXKernelState.finalize} hoists before the loop.
 * Pure over a {@link FXKernelTarget} - no dependency on the SSA accumulator or the per-node context.
 */

import type { FXKernelIntegration } from "./FXCompiledKernel";
import type { FXExpr } from "../core/ir/FXExpr";
import { printJS } from "../core/codegen/printJS.Internal";
import type { FXKernelTarget } from "./FXParticleBehaviorTarget";
import { FX_EMITTER_INPUT_FIELD, FX_PARTICLE_INDEX_INPUT } from "./FXParticleBehaviorTarget";
import { BUILTIN_BUFFER, bufferAccess, FX_BEHAVIOR_ALL_FUNCTIONS } from "./FXKernelShared.Internal";

/** Prints a ref to its JS access string for {@link printJS} (phase-level: depends only on the target). */
export function resolveKernelRef(
  target: FXKernelTarget,
  candidate: Extract<FXExpr, { kind: "ref" }>,
): string {
  switch (candidate.ref) {
    case "local":
    case "binding":
      return candidate.name;
    case "targetInput":
      return resolveKernelTargetInputRef(target, candidate.name);
    case "uniform":
    case "attribute":
      throw new Error(
        `resolveKernelRef: ref kind "${candidate.ref}" is not valid in the behavior backend`,
      );
  }
}

/**
 * Resolves a (possibly `@component`-encoded) input ref to its JS access string:
 * `s_<buffer>[b_<buffer> + off]` for a buffer builtin, `dt` for the timestep, or
 * `emitter.<field>[component]` for a host-provided emitter transform input.
 */
function resolveKernelTargetInputRef(target: FXKernelTarget, encoded: string): string {
  const at = encoded.lastIndexOf("@");
  const inputName = at === -1 ? encoded : encoded.slice(0, at);
  const component = at === -1 ? 0 : Number(encoded.slice(at + 1));
  const input = target.inputs.find((candidate) => candidate.name === inputName);
  if (input?.offsets === undefined) {
    if (inputName === "dt") {
      return "dt";
    }
    // The particle's own index: the JS loop variable, already the buffer slot index in both the
    // spawn and update loop headers (see FXKernelBuild.Internal.ts's SPAWN/UPDATE_LOOP_HEADER).
    if (inputName === FX_PARTICLE_INDEX_INPUT) {
      return "i";
    }
    const field = FX_EMITTER_INPUT_FIELD[inputName];
    if (field !== undefined) {
      return `emitter.${field}[${component.toString()}]`;
    }
    throw new Error(`resolveKernelTargetInputRef: input "${inputName}" has no state offset`);
  }
  const offset = input.offsets[component];
  if (offset === undefined) {
    throw new Error(
      `resolveKernelTargetInputRef: input "${inputName}" has no offset for component ${component.toString()}`,
    );
  }
  return bufferAccess(input.buffer ?? BUILTIN_BUFFER, offset);
}

/**
 * Whether a (non-`local`) ref reads a particle-invariant value - the policy behind the
 * loop-invariant hoist. Bindings (param values) are constant within a call; a `targetInput`
 * is invariant iff it is offset-less (`dt`, the emitter transform) and variant when it reads a
 * per-particle buffer (`PARTICLE_*`, `ATTR_*`) - except `PARTICLE_INDEX` (also offset-less, but
 * it *is* the loop variable, different every iteration by construction; the general offset-less
 * rule would otherwise wrongly hoist it out of the loop). Attribute/uniform refs are
 * per-particle/absent.
 */
export function isInvariantKernelRef(
  target: FXKernelTarget,
  ref: Extract<FXExpr, { kind: "ref" }>,
): boolean {
  switch (ref.ref) {
    case "binding":
      return true;
    case "targetInput": {
      const at = ref.name.lastIndexOf("@");
      const inputName = at === -1 ? ref.name : ref.name.slice(0, at);
      if (inputName === "dt") {
        return true;
      }
      if (inputName === FX_PARTICLE_INDEX_INPUT) {
        return false;
      }
      const input = target.inputs.find((candidate) => candidate.name === inputName);
      return input?.offsets === undefined;
    }
    case "local":
    case "uniform":
    case "attribute":
      return false;
  }
}

/** Resolves a target-input (or `dt`) to its buffer-aware JS accessor for the epilogue. */
function targetInputToJS(target: FXKernelTarget, name: string): string {
  if (name === "dt") {
    return "dt";
  }
  const input = target.inputs.find((candidate) => candidate.name === name);
  if (input?.offsets === undefined) {
    throw new Error(`compilePhase: integration reads input "${name}" with no state offset`);
  }
  const offset = input.offsets[0];
  if (offset === undefined) {
    throw new Error(`targetInputToJS: input "${name}" declares offsets but has none`);
  }
  return bufferAccess(input.buffer ?? BUILTIN_BUFFER, offset);
}

/**
 * Prints the target's structured integration into epilogue statements. Motion
 * integration writes the builtin state (`s_builtin[b_builtin + off] = ...`); its
 * reads resolve through the (possibly attribute) buffer each input names.
 */
export function generateEpilogue(
  integration: readonly FXKernelIntegration[],
  target: FXKernelTarget,
): string[] {
  return integration.map((step) => {
    const { code } = printJS(step.expr, FX_BEHAVIOR_ALL_FUNCTIONS, (candidate) => {
      if (candidate.ref !== "targetInput") {
        throw new Error(`compilePhase: integration ref "${candidate.ref}" must be a target input`);
      }
      return targetInputToJS(target, candidate.name);
    });
    return `${bufferAccess(BUILTIN_BUFFER, step.offset)} = ${code};`;
  });
}
