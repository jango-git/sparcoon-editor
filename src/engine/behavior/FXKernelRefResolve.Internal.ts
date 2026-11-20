/**
 * Resolves kernel refs to JS access strings and decides which refs FXKernelState.finalize hoists
 * out of the loop.
 */

import { FX_AGE, FX_CORE_LIFECYCLE } from "sparcoon";

import { printJS } from "../core/codegen/printJS.Internal";
import type { FXExpr } from "../core/ir/FXExpr";
import type { FXKernelIntegration } from "./FXCompiledKernel";
import {
  bufferAccess,
  BUILTIN_BUFFER,
  FX_BEHAVIOR_ALL_FUNCTIONS,
  INHERITED_PARAMETER,
} from "./FXKernelShared.Internal";
import type { FXKernelTarget, FXKernelTargetInput } from "./FXParticleBehaviorTarget";

// Where a column-major mat4 keeps its translation: the part of the model matrix a birth moves.
const TRANSLATION_COMPONENT = 12;

/** The axis of the translation `component` of an at-birth input reads, if it reads one. */
function birthTranslationAxis(
  input: FXKernelTargetInput | undefined,
  component: number,
): number | undefined {
  const axis = component - TRANSLATION_COMPONENT;
  return input?.atBirth === true && axis >= 0 && axis < 3 ? axis : undefined;
}

export interface TargetInputRead {
  readonly name: string;
  /** Undefined when the target declares no such input. */
  readonly input: FXKernelTargetInput | undefined;
  /** Undefined for the whole value. */
  readonly component: number | undefined;
}

export function targetInputOf(target: FXKernelTarget, encoded: string): TargetInputRead {
  const at = encoded.lastIndexOf("@");
  const name = at === -1 ? encoded : encoded.slice(0, at);
  return {
    name,
    input: target.inputs.find((candidate) => candidate.name === name),
    component: at === -1 ? undefined : Number(encoded.slice(at + 1)),
  };
}

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

function resolveKernelTargetInputRef(target: FXKernelTarget, encoded: string): string {
  const read = targetInputOf(target, encoded);
  const { name, input } = read;
  const component = read.component ?? 0;
  if (input === undefined) {
    throw new Error(`resolveKernelTargetInputRef: target declares no input "${name}"`);
  }
  if (input.inheritOffset !== undefined) {
    return `${INHERITED_PARAMETER}[${(input.inheritOffset + component).toString()}]`;
  }
  if (input.host !== undefined) {
    switch (input.host.kind) {
      case "parameter":
        return input.host.parameter;
      case "particleIndex":
        return "i";
      case "emitter": {
        const access = `emitter.${input.host.field}[${component.toString()}]`;
        const axis = birthTranslationAxis(input, component);
        if (axis === undefined) {
          return access;
        }
        // Where the emitter stood `age` seconds ago: the age the runtime seeded the newborn with.
        return `(${access} - emitter.velocity[${axis.toString()}] * ${bufferAccess(FX_CORE_LIFECYCLE, FX_AGE)})`;
      }
    }
  }
  const offset = input.offsets?.[component];
  if (offset === undefined) {
    throw new Error(
      `resolveKernelTargetInputRef: input "${name}" has no offset for component ${component.toString()}`,
    );
  }
  return bufferAccess(input.buffer ?? BUILTIN_BUFFER, offset);
}

/**
 * Whether a (non-`local`) ref reads a particle-invariant value - the policy behind the
 * loop-invariant hoist. Bindings (param values) are constant within a call, and so are what the
 * caller passes and what a spawn call's newborns inherit - except the particle's own index and an
 * at-birth model matrix's translation (see `FXKernelTargetInput.atBirth`). What a slot holds
 * varies by particle. Attribute/uniform refs are per-particle/absent.
 */
export function isInvariantKernelRef(
  target: FXKernelTarget,
  ref: Extract<FXExpr, { kind: "ref" }>,
): boolean {
  switch (ref.ref) {
    case "binding":
      return true;
    case "targetInput":
      return isInvariantTargetInput(targetInputOf(target, ref.name));
    case "local":
    case "uniform":
    case "attribute":
      return false;
  }
}

function isInvariantTargetInput({ input, component }: TargetInputRead): boolean {
  if (input?.inheritOffset !== undefined) {
    return true;
  }
  switch (input?.host?.kind) {
    case undefined:
    case "particleIndex":
      return false;
    case "parameter":
      return true;
    case "emitter":
      // A whole at-birth matrix holds its translation; of its components, only those vary.
      return (
        input.atBirth !== true ||
        (component !== undefined && birthTranslationAxis(input, component) === undefined)
      );
  }
}

export function generateEpilogue(
  integration: readonly FXKernelIntegration[],
  target: FXKernelTarget,
): string[] {
  return integration.map((step) => {
    const { code } = printJS(step.expr, FX_BEHAVIOR_ALL_FUNCTIONS, (candidate) => {
      if (candidate.ref !== "targetInput") {
        throw new Error(`compilePhase: integration ref "${candidate.ref}" must be a target input`);
      }
      return resolveKernelTargetInputRef(target, candidate.name);
    });
    return `${bufferAccess(BUILTIN_BUFFER, step.offset)} = ${code};`;
  });
}
