import type {
  FXBehaviorTargets,
  FXKernelTarget,
  FXKernelTargetInput,
  FXKernelTargetOutput,
} from "../../src/engine/behavior/FXParticleBehaviorTarget";
import type { FXValueType } from "../../src/engine/core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";

/**
 * A worked example of a non-particle behavior target, kept as a test helper (NOT
 * part of sparcoon's public surface): an **update-only value target** that animates
 * a named set of values with no particle semantics (no spawn phase, no lifetime, no
 * integration). It is the seam a VFX-mesh host in the editor would author itself -
 * the library only guarantees the optional-spawn phase (P3.1) and that `FXKernelTarget`
 * is plain data.
 *
 * All the named values are packed into one `values` state buffer (stride = the sum
 * of their component counts). Each value gets:
 * - an **input** `VALUE_<name>` reading its current packed value (so an update node
 *   can compose against it), and
 * - an **output slot** `<name>` a graph binds to write it.
 *
 * The buffer is the state: it persists across `update()` calls (like the particle
 * `builtin` buffer), so the host reads it after each `update()` and unpacks the
 * values into its own uniforms / material parameters - that wiring is entirely
 * host-side. `dt` is exposed so a graph can advance a value over time.
 *
 * This mirrors {@link buildParticleBehaviorTargets} but for a single element and
 * without the particle vocabulary - the point being that no library change is
 * needed to define it, only `FXKernelTarget` data + the optional spawn phase.
 */

const FLOAT = FX_VALUE_TYPES.float;

/** One named value the target animates: a name and its element type. */
export interface FXValueSlot {
  readonly name: string;
  readonly type: FXValueType;
}

/** The single state buffer holding every packed value. */
export const VALUES_BUFFER = "values";

/** Input name a graph reads to sample the current value of `name`. */
export function valueInputName(name: string): string {
  return `VALUE_${name}`;
}

/** Total float stride of a value-slot schema (the `values` buffer per-element size). */
export function valueStride(slots: readonly FXValueSlot[]): number {
  return slots.reduce((sum, slot) => sum + slot.type.components, 0);
}

/**
 * Builds an update-only {@link FXBehaviorTargets} for a value-slot schema. The slot
 * schema is folded into the target name (salting the structural hash), exactly as
 * the attribute set is for particle targets.
 */
export function buildValueBehaviorTarget(slots: readonly FXValueSlot[]): FXBehaviorTargets {
  const inputs: FXKernelTargetInput[] = [];
  const outputs: FXKernelTargetOutput[] = [];
  let offset = 0;
  for (const slot of slots) {
    const baseOffset = offset;
    const offsets = Array.from({ length: slot.type.components }, (_, i) => baseOffset + i);
    inputs.push({
      name: valueInputName(slot.name),
      type: slot.type,
      buffer: VALUES_BUFFER,
      offsets,
    });
    outputs.push({
      slot: slot.name,
      type: slot.type,
      required: false,
      buffer: VALUES_BUFFER,
      offsets,
    });
    offset += slot.type.components;
  }
  const schema = slots.map((slot) => `${slot.name}:${slot.type.glslTypeName}`).join(",");
  const update: FXKernelTarget = {
    name: `value-update{${schema}}`,
    buffers: [{ name: VALUES_BUFFER, stride: offset }],
    // `dt` lets a graph advance a value over time; the VALUE_* inputs let it read
    // the current (persisted) value. No integration, no preamble - plain writes.
    inputs: [...inputs, { name: "dt", type: FLOAT }],
    outputs,
  };
  // No spawn phase: an update-only target (the P3.1 seam).
  return { update };
}
