import { FX_CORE_LIFECYCLE, FX_CORE_LIFECYCLE_STRIDE } from "sparcoon";

import type { FXCompilerError } from "../core/compiler/FXCompilerError";
import {
  IDENTIFIER_PATTERN,
  isRecord,
  isValueTypeShape,
  shapeError,
  valueTypeError,
} from "../core/compiler/targetLint.Internal";
import type { FXExpr } from "../core/ir/FXExpr";
import { childrenOf } from "../core/ir/visit.Internal";
import { SPAWN_KERNEL_PARAMETERS, UPDATE_KERNEL_PARAMETERS } from "./FXKernelShared.Internal";
import type { FXKernelTarget, FXKernelTargetInput } from "./FXParticleBehaviorTarget";

const BUILTIN_BUFFER = "builtin";

function visitRefs(expr: FXExpr, visit: (ref: Extract<FXExpr, { kind: "ref" }>) => void): void {
  if (expr.kind === "ref") {
    visit(expr);
  }
  for (const child of childrenOf(expr)) {
    visitRefs(child, visit);
  }
}

/**
 * Lints a host-provided kernel target, reporting `invalid-target` instead of a ReferenceError on
 * the first frame. An input may read only parameters the phase's kernel takes (a spawn kernel has
 * no `dt`).
 */
export function validateKernelTarget(
  target: FXKernelTarget,
  phase: "spawn" | "update",
): FXCompilerError[] {
  // A hand-authored target's shape isn't guaranteed by the type system at runtime; guard it
  // first so the semantic lint below can trust the shape and never TypeErrors.
  const shapeErrors = kernelTargetShapeErrors(target);
  if (shapeErrors.length > 0) {
    return shapeErrors;
  }

  const errors: FXCompilerError[] = [];
  const strides = new Map<string, number>();
  for (const buffer of target.buffers) {
    // Buffer names are spliced into the kernel source as `b_<name>` locals, so a
    // non-identifier is a `new Function` SyntaxError. The plain-identifier form also rejects
    // the `$` generated locals use, so a lint-passing name can never collide with them.
    if (!IDENTIFIER_PATTERN.test(buffer.name)) {
      errors.push({
        code: "bad-target-buffer-identifier",
        message: `target "${target.name}" buffer "${buffer.name}" is not a valid identifier (it is spliced into the generated kernel source)`,
        params: { targetName: target.name, bufferName: buffer.name },
      });
    }
    if (strides.has(buffer.name)) {
      errors.push({
        code: "duplicate-target-buffer",
        message: `target "${target.name}" declares buffer "${buffer.name}" more than once`,
        params: { targetName: target.name, bufferName: buffer.name },
      });
    }
    if (!Number.isInteger(buffer.stride) || buffer.stride <= 0) {
      // A NaN/fractional stride silently corrupts per-particle storage
      // (`Float32Array[NaN] = x` is a no-op; a fractional base skips elements).
      errors.push({
        code: "bad-target-buffer-stride",
        message: `target "${target.name}" buffer "${buffer.name}" stride ${String(buffer.stride)} must be a positive integer`,
        params: { targetName: target.name, bufferName: buffer.name, stride: String(buffer.stride) },
      });
    }
    strides.set(buffer.name, buffer.stride);
  }

  /** Checks that `offsets` are integers fitting `buffer`'s stride; reports against `label`. */
  const checkOffsets = (buffer: string, offsets: readonly number[], label: string): void => {
    const stride = strides.get(buffer);
    if (stride === undefined) {
      errors.push({
        code: "undeclared-target-buffer",
        message: `target "${target.name}" ${label} names buffer "${buffer}", which is not declared`,
        params: { targetName: target.name, label, buffer },
      });
      return;
    }
    for (const offset of offsets) {
      if (!Number.isInteger(offset)) {
        errors.push({
          code: "bad-target-offset",
          message: `target "${target.name}" ${label} offset ${String(offset)} must be an integer`,
          params: { targetName: target.name, label, offset: String(offset) },
        });
      } else if (offset < 0 || offset >= stride) {
        errors.push({
          code: "target-offset-out-of-bounds",
          message: `target "${target.name}" ${label} offset ${offset.toString()} is outside buffer "${buffer}" (stride ${stride.toString()})`,
          params: { targetName: target.name, label, offset, buffer, stride },
        });
      }
    }
  };

  const seenInputs = new Set<string>();
  for (const input of target.inputs) {
    if (!IDENTIFIER_PATTERN.test(input.name)) {
      // `@` in particular would alias the kernel's internal `name@component`
      // vector encoding and silently read another input's component.
      errors.push({
        code: "bad-target-input-identifier",
        message: `target "${target.name}" input "${input.name}" is not a valid identifier`,
        params: { targetName: target.name, inputName: input.name },
      });
    }
    if (seenInputs.has(input.name)) {
      errors.push({
        code: "duplicate-target-input",
        message: `target "${target.name}" declares input "${input.name}" more than once`,
        params: { targetName: target.name, inputName: input.name },
      });
    }
    seenInputs.add(input.name);
    const sourceError = inputSourceError(target, phase, input);
    if (sourceError !== undefined) {
      errors.push(sourceError);
      continue;
    }
    const typeError = valueTypeError(target.name, input.type, `input "${input.name}"`);
    if (typeError !== undefined) {
      errors.push(typeError);
      continue;
    }
    if (input.atBirth === true) {
      errors.push(...atBirthErrors(target, phase, input));
    }
    if (input.inheritOffset !== undefined) {
      errors.push(...inheritInputErrors(target, phase, input));
      continue;
    }
    if (input.offsets !== undefined) {
      if (input.offsets.length !== input.type.components) {
        errors.push({
          code: "target-input-offset-count-mismatch",
          message: `target "${target.name}" input "${input.name}" has ${input.offsets.length.toString()} offset(s) but its ${input.type.id} type needs ${input.type.components.toString()}`,
          params: {
            targetName: target.name,
            inputName: input.name,
            offsetCount: input.offsets.length,
            typeId: input.type.id,
            typeComponents: input.type.components,
          },
        });
      }
      checkOffsets(input.buffer ?? BUILTIN_BUFFER, input.offsets, `input "${input.name}"`);
    }
  }

  const seenOutputs = new Set<string>();
  for (const output of target.outputs) {
    if (seenOutputs.has(output.slot)) {
      errors.push({
        code: "duplicate-target-output",
        message: `target "${target.name}" declares output slot "${output.slot}" more than once`,
        params: { targetName: target.name, outputSlot: output.slot },
      });
    }
    seenOutputs.add(output.slot);
    const typeError = valueTypeError(target.name, output.type, `output "${output.slot}"`);
    if (typeError !== undefined) {
      errors.push(typeError);
      continue;
    }
    if (output.offsets.length !== output.type.components) {
      errors.push({
        code: "target-output-offset-count-mismatch",
        message: `target "${target.name}" output "${output.slot}" has ${output.offsets.length.toString()} offset(s) but its ${output.type.id} type needs ${output.type.components.toString()}`,
        params: {
          targetName: target.name,
          outputSlot: output.slot,
          offsetCount: output.offsets.length,
          typeId: output.type.id,
          typeComponents: output.type.components,
        },
      });
    }
    // A repeated offset within one slot (e.g. a vec3 with offsets [0, 0, 1]) means one
    // component silently overwrites another - the cross-slot detector cannot see it.
    const duplicateOffset = firstDuplicateOffset(output.offsets);
    if (duplicateOffset !== undefined) {
      errors.push({
        code: "duplicate-output-offset-write",
        message: `target "${target.name}" output "${output.slot}" writes offset ${duplicateOffset.toString()} more than once (a component would be silently overwritten)`,
        params: { targetName: target.name, outputSlot: output.slot, offset: duplicateOffset },
      });
    }
    checkOffsets(output.buffer ?? BUILTIN_BUFFER, output.offsets, `output "${output.slot}"`);
  }

  if (target.killSlot !== undefined) {
    errors.push(...killSlotErrors(target, phase, seenOutputs));
  }

  const integration = target.integration ?? [];
  if (integration.length > 0) {
    const inputNames = new Set(target.inputs.map((input) => input.name));
    const seenIntegrationOffsets = new Set<number>();
    for (const step of integration) {
      // Integration always writes the packed builtin state.
      checkOffsets(BUILTIN_BUFFER, [step.offset], "integration");
      // Two steps writing the same offset: the later one silently wins.
      if (seenIntegrationOffsets.has(step.offset)) {
        errors.push({
          code: "duplicate-integration-offset-write",
          message: `target "${target.name}" integration writes offset ${step.offset.toString()} in more than one step (a later step silently overwrites an earlier one)`,
          params: { targetName: target.name, offset: step.offset },
        });
      }
      seenIntegrationOffsets.add(step.offset);
      visitRefs(step.expr, (ref) => {
        // The JS printers can only resolve scalar target-input reads here; any
        // other ref kind or a vector type would surface as a bare compile throw.
        if (ref.ref !== "targetInput") {
          errors.push({
            code: "integration-ref-not-target-input",
            message: `target "${target.name}" integration contains a "${ref.ref}" ref ("${ref.name}"); integration expressions may only read target inputs`,
            params: { targetName: target.name, refKind: ref.ref, refName: ref.name },
          });
          return;
        }
        if (ref.type.components !== 1) {
          errors.push({
            code: "integration-ref-not-scalar",
            message: `target "${target.name}" integration reads input "${ref.name}" as a ${ref.type.id}; integration refs must be scalar`,
            params: { targetName: target.name, refName: ref.name, typeId: ref.type.id },
          });
          return;
        }
        if (!inputNames.has(ref.name)) {
          errors.push({
            code: "integration-input-not-declared",
            message: `target "${target.name}" integration reads input "${ref.name}", which is not declared`,
            params: { targetName: target.name, refName: ref.name },
          });
        }
      });
    }
  }

  return errors;
}

const KERNEL_PARAMETERS: Readonly<Record<"spawn" | "update", readonly string[]>> = {
  spawn: SPAWN_KERNEL_PARAMETERS,
  update: UPDATE_KERNEL_PARAMETERS,
};

/** What is wrong with where an input comes from: no place or more than one, or a kernel parameter
 *  the phase's kernel does not take. */
function inputSourceError(
  target: FXKernelTarget,
  phase: "spawn" | "update",
  input: FXKernelTargetInput,
): FXCompilerError | undefined {
  const params = { targetName: target.name, inputName: input.name };
  const sources = [input.offsets, input.inheritOffset, input.host].filter(
    (source) => source !== undefined,
  ).length;
  if (sources === 0) {
    return {
      code: "input-has-no-source",
      message: `target "${target.name}" input "${input.name}" comes from nowhere: it has no offsets, no inherit offset and no host value`,
      params,
    };
  }
  if (sources > 1) {
    return {
      code: "input-has-several-sources",
      message: `target "${target.name}" input "${input.name}" comes from more than one of its offsets, its inherit offset and its host value`,
      params,
    };
  }
  if (
    input.host?.kind === "parameter" &&
    !KERNEL_PARAMETERS[phase].includes(input.host.parameter)
  ) {
    return {
      code: "input-parameter-not-in-phase",
      message: `target "${target.name}" input "${input.name}" reads "${input.host.parameter}", but a ${phase} kernel has no such parameter`,
      params: { ...params, parameter: input.host.parameter, phase },
    };
  }
  return undefined;
}

function hasCoreLifecycle(target: FXKernelTarget): boolean {
  const lifecycle = target.buffers.find((buffer) => buffer.name === FX_CORE_LIFECYCLE);
  return lifecycle?.stride === FX_CORE_LIFECYCLE_STRIDE;
}

/**
 * What is wrong with an inherited input: one outside a spawn target (only births inherit), or one
 * whose floats do not lie inside the target's inherit layout.
 */
function inheritInputErrors(
  target: FXKernelTarget,
  phase: "spawn" | "update",
  input: FXKernelTargetInput,
): FXCompilerError[] {
  const params = { targetName: target.name, inputName: input.name };
  if (phase !== "spawn") {
    return [
      {
        code: "inherit-input-not-in-spawn",
        message: `target "${target.name}" declares inherited input "${input.name}", but only a spawn kernel's births inherit`,
        params,
      },
    ];
  }
  const offset = input.inheritOffset ?? 0;
  const stride = target.inherit?.layout.stride ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset + input.type.components > stride) {
    return [
      {
        code: "inherit-input-out-of-layout",
        message: `target "${target.name}" inherited input "${input.name}" does not lie inside its inherit layout of ${stride.toString()} floats`,
        params: { ...params, stride },
      },
    ];
  }
  return [];
}

function atBirthErrors(
  target: FXKernelTarget,
  phase: "spawn" | "update",
  input: FXKernelTargetInput,
): FXCompilerError[] {
  const inputName = input.name;
  const errors: FXCompilerError[] = [];
  const params = { targetName: target.name, inputName };
  if (input.host?.kind !== "emitter" || input.host.field !== "worldMatrix") {
    errors.push({
      code: "at-birth-input-not-model-matrix",
      message: `target "${target.name}" reads input "${inputName}" at birth, but only the model matrix moves with a birth`,
      params,
    });
  }
  if (phase !== "spawn") {
    errors.push({
      code: "at-birth-input-not-in-spawn",
      message: `target "${target.name}" reads input "${inputName}" at birth, but only a spawn kernel has births`,
      params,
    });
  }
  if (!hasCoreLifecycle(target)) {
    errors.push({
      code: "at-birth-input-needs-lifecycle",
      message: `target "${target.name}" reads input "${inputName}" at birth without the "lifecycle" buffer holding the age it moves by`,
      params,
    });
  }
  return errors;
}

/** A kill slot needs an update kernel and the lifecycle it acts on, and a name of its own. */
function killSlotErrors(
  target: FXKernelTarget,
  phase: "spawn" | "update",
  outputSlots: ReadonlySet<string>,
): FXCompilerError[] {
  const errors: FXCompilerError[] = [];
  const slot = target.killSlot ?? "";
  if (phase === "spawn") {
    errors.push({
      code: "kill-slot-in-spawn",
      message: `target "${target.name}" declares a kill slot, but only an update kernel can kill`,
      params: { targetName: target.name },
    });
  }
  if (!hasCoreLifecycle(target)) {
    errors.push({
      code: "kill-slot-needs-lifecycle",
      message: `target "${target.name}" declares a kill slot without the "lifecycle" buffer it acts on`,
      params: { targetName: target.name },
    });
  }
  if (outputSlots.has(slot)) {
    errors.push({
      code: "duplicate-target-output",
      message: `target "${target.name}" declares output slot "${slot}" more than once`,
      params: { targetName: target.name, outputSlot: slot },
    });
  }
  return errors;
}

function isNumberArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function firstDuplicateOffset(offsets: readonly number[]): number | undefined {
  const seen = new Set<number>();
  for (const offset of offsets) {
    if (seen.has(offset)) {
      return offset;
    }
    seen.add(offset);
  }
  return undefined;
}

export function kernelTargetShapeErrors(target: unknown): FXCompilerError[] {
  if (!isRecord(target)) {
    return [shapeError("<unknown>", "target", "an object")];
  }
  const name = typeof target["name"] === "string" ? target["name"] : "<unnamed>";
  const errors: FXCompilerError[] = [];
  if (typeof target["name"] !== "string") {
    errors.push(shapeError(name, "name", "a string"));
  }

  const buffers = target["buffers"];
  if (!Array.isArray(buffers)) {
    errors.push(shapeError(name, "buffers", "an array"));
  } else {
    buffers.forEach((buffer: unknown, index: number): void => {
      const path = `buffers[${index.toString()}]`;
      if (!isRecord(buffer)) {
        errors.push(shapeError(name, path, "an object"));
        return;
      }
      if (typeof buffer["name"] !== "string") {
        errors.push(shapeError(name, `${path}.name`, "a string"));
      }
      if (typeof buffer["stride"] !== "number") {
        errors.push(shapeError(name, `${path}.stride`, "a number"));
      }
    });
  }

  const inputs = target["inputs"];
  if (!Array.isArray(inputs)) {
    errors.push(shapeError(name, "inputs", "an array"));
  } else {
    inputs.forEach((input: unknown, index: number): void => {
      const path = `inputs[${index.toString()}]`;
      if (!isRecord(input)) {
        errors.push(shapeError(name, path, "an object"));
        return;
      }
      if (typeof input["name"] !== "string") {
        errors.push(shapeError(name, `${path}.name`, "a string"));
      }
      if (!isValueTypeShape(input["type"])) {
        errors.push(shapeError(name, `${path}.type`, "an FXValueType"));
      }
      if (input["offsets"] !== undefined && !isNumberArray(input["offsets"])) {
        errors.push(shapeError(name, `${path}.offsets`, "an array of numbers"));
      }
      if (input["buffer"] !== undefined && typeof input["buffer"] !== "string") {
        errors.push(shapeError(name, `${path}.buffer`, "a string"));
      }
      if (input["atBirth"] !== undefined && typeof input["atBirth"] !== "boolean") {
        errors.push(shapeError(name, `${path}.atBirth`, "a boolean"));
      }
    });
  }

  const outputs = target["outputs"];
  if (!Array.isArray(outputs)) {
    errors.push(shapeError(name, "outputs", "an array"));
  } else {
    outputs.forEach((output: unknown, index: number): void => {
      const path = `outputs[${index.toString()}]`;
      if (!isRecord(output)) {
        errors.push(shapeError(name, path, "an object"));
        return;
      }
      if (typeof output["slot"] !== "string") {
        errors.push(shapeError(name, `${path}.slot`, "a string"));
      }
      if (!isValueTypeShape(output["type"])) {
        errors.push(shapeError(name, `${path}.type`, "an FXValueType"));
      }
      if (!isNumberArray(output["offsets"])) {
        errors.push(shapeError(name, `${path}.offsets`, "an array of numbers"));
      }
      if (typeof output["required"] !== "boolean") {
        errors.push(shapeError(name, `${path}.required`, "a boolean"));
      }
      if (output["buffer"] !== undefined && typeof output["buffer"] !== "string") {
        errors.push(shapeError(name, `${path}.buffer`, "a string"));
      }
    });
  }

  const integration = target["integration"];
  if (integration !== undefined) {
    if (!Array.isArray(integration)) {
      errors.push(shapeError(name, "integration", "an array"));
    } else {
      integration.forEach((step: unknown, index: number): void => {
        const path = `integration[${index.toString()}]`;
        if (!isRecord(step)) {
          errors.push(shapeError(name, path, "an object"));
          return;
        }
        if (typeof step["offset"] !== "number") {
          errors.push(shapeError(name, `${path}.offset`, "a number"));
        }
        if (!isRecord(step["expr"])) {
          errors.push(shapeError(name, `${path}.expr`, "an expression object"));
        }
      });
    }
  }

  if (target["killSlot"] !== undefined && typeof target["killSlot"] !== "string") {
    errors.push(shapeError(name, "killSlot", "a string"));
  }

  const preamble = target["preamble"];
  if (
    preamble !== undefined &&
    !(Array.isArray(preamble) && preamble.every((line) => typeof line === "string"))
  ) {
    errors.push(shapeError(name, "preamble", "an array of strings"));
  }

  return errors;
}
