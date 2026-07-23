import type { FXCompilerError } from "../core/compiler/FXCompilerError";
import type { FXExpr } from "../core/ir/FXExpr";
import { childrenOf } from "../core/ir/visit.Internal";
import {
  IDENTIFIER_PATTERN,
  isRecord,
  isValueTypeShape,
  shapeError,
  valueTypeError,
} from "../core/compiler/targetLint.Internal";
import type { FXKernelTarget } from "./FXParticleBehaviorTarget";
import { FX_EMITTER_INPUT_FIELD, FX_PARTICLE_INDEX_INPUT } from "./FXParticleBehaviorTarget";

/** The packed builtin state buffer the kernel's integration always writes into. */
const BUILTIN_BUFFER = "builtin";

/** Invokes `visit` on every `ref` node reachable in an expression tree. */
function visitRefs(expr: FXExpr, visit: (ref: Extract<FXExpr, { kind: "ref" }>) => void): void {
  if (expr.kind === "ref") {
    visit(expr);
  }
  for (const child of childrenOf(expr)) {
    visitRefs(child, visit);
  }
}

/**
 * Structurally lints a behavior {@link FXKernelTarget} - host-provided data, so a shape
 * violation surfaces as `invalid-target` here rather than a `ReferenceError` on the first
 * frame or silent cross-particle corruption. Phase-aware: `dt` is a spawn-target error
 * (a spawn kernel has no timestep), catching a copy-pasted update integration.
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
    // Buffer names are spliced into the kernel source as `s_<name>`/`b_<name>` locals, so a
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
    if (phase === "spawn" && input.name === "dt") {
      errors.push({
        code: "spawn-input-has-dt",
        message: `target "${target.name}" declares input "dt", but a spawn kernel has no dt`,
        params: { targetName: target.name },
      });
      continue;
    }
    if (input.name === "dt" && input.offsets !== undefined) {
      // `dt` is the synthesized timestep and must stay offset-less; an offset-bearing
      // `dt` would read a buffer instead of the loop timestep (see the offset-less rule below).
      errors.push({
        code: "dt-input-has-offsets",
        message: `target "${target.name}" declares input "dt" with offsets; "dt" is the synthesized timestep and must be offset-less`,
        params: { targetName: target.name },
      });
      continue;
    }
    const typeError = valueTypeError(target.name, input.type, `input "${input.name}"`);
    if (typeError !== undefined) {
      errors.push(typeError);
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
    } else if (
      input.name !== "dt" &&
      input.name !== FX_PARTICLE_INDEX_INPUT &&
      FX_EMITTER_INPUT_FIELD[input.name] === undefined
    ) {
      // Offset-less inputs are reserved for `dt`, `PARTICLE_INDEX`, and the emitter-transform
      // fields (FX_EMITTER_INPUT_FIELD); anything else must be backed by buffer storage.
      errors.push({
        code: "offsetless-input-not-reserved",
        message: `target "${target.name}" input "${input.name}" declares no offsets; offset-less inputs are reserved for "dt", "PARTICLE_INDEX", and the model matrix`,
        params: { targetName: target.name, inputName: input.name },
      });
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
        // `dt` need not be a declared input (only the update kernel has it); the exact-name
        // check also rejects the internal `name@component` encoding, unsupported here.
        if (ref.name === "dt") {
          if (phase === "spawn") {
            errors.push({
              code: "integration-reads-dt-in-spawn",
              message: `target "${target.name}" integration reads "dt", but a spawn kernel has no dt`,
              params: { targetName: target.name },
            });
          }
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

/** Whether `value` is an array of numbers (offsets). */
function isNumberArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

/** The first offset appearing more than once in `offsets`, or `undefined`. */
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

/**
 * Structural (shape) check of a kernel target, so a malformed host literal surfaces as
 * `invalid-target` errors here instead of a TypeError inside `validate`/`apply`.
 */
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

  const preamble = target["preamble"];
  if (
    preamble !== undefined &&
    !(Array.isArray(preamble) && preamble.every((line) => typeof line === "string"))
  ) {
    errors.push(shapeError(name, "preamble", "an array of strings"));
  }

  return errors;
}
