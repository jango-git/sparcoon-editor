import type { FXBufferLayout } from "sparcoon";
import { type FXSlotLayout, slotLayout } from "sparcoon/editor";

/**
 * Per-field views of a JS kernel's slots, for tests: a kernel indexes one interleaved array
 * (every particle's slot back to back, laid out by sparcoon's `slotLayout`), while a test reads and
 * seeds plain per-field arrays (`fields.position[i * 3 + c]`). {@link overFields} converts both
 * ways around one call.
 */

/** Every field of a run of slots as its own tightly packed array, by buffer name. */
export type FieldBuffers = Record<string, Float32Array>;

/** `Kernel` (a spawn/update over slots) as {@link overFields} returns it: over per-field arrays. */
export type FieldKernel<Kernel> = Kernel extends (slots: Float32Array, ...rest: infer Rest) => void
  ? (fields: FieldBuffers, ...rest: Rest) => void
  : never;

/** The slot `buffers` lay out, by their own names. */
export function slotOf(buffers: readonly FXBufferLayout[]): FXSlotLayout {
  return slotLayout(buffers.map((buffer) => ({ name: buffer.name, components: buffer.stride })));
}

/** Interleaves `fields` into a fresh slots array for `count` particles. */
export function mergeFields(slot: FXSlotLayout, fields: FieldBuffers, count: number): Float32Array {
  const slots = new Float32Array(count * slot.stride);
  for (const field of slot.fields) {
    const array = fields[field.name] as Float32Array | undefined;
    if (array === undefined) {
      continue;
    }
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < field.components; c++) {
        // A test may seed a field shorter than the run (only the components it cares about).
        slots[i * slot.stride + field.offset + c] = array[i * field.components + c] ?? 0;
      }
    }
  }
  return slots;
}

/** Copies each field of `slots` back into `fields` - in place, so a test's references stay live. */
export function splitFields(slot: FXSlotLayout, slots: Float32Array, fields: FieldBuffers): void {
  const count = slots.length / slot.stride;
  for (const field of slot.fields) {
    const array = (fields[field.name] ??= new Float32Array(count * field.components));
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < field.components; c++) {
        array[i * field.components + c] = slots[i * slot.stride + field.offset + c];
      }
    }
  }
}

/** Zeroed per-field arrays for `count` particles of a kernel declaring `buffers`. */
export function fieldsFor(buffers: readonly FXBufferLayout[], count = 1): FieldBuffers {
  const fields: FieldBuffers = {};
  for (const buffer of buffers) {
    fields[buffer.name] = new Float32Array(buffer.stride * count);
  }
  return fields;
}

/**
 * `kernel` (a compiled or artifact spawn/update, over slots laid out by `buffers`) called on
 * per-field arrays instead: they are interleaved into slots, the kernel runs, and every field is
 * copied back into them. The particle count is read off the arrays.
 */
export function overFields<Rest extends unknown[]>(
  buffers: readonly FXBufferLayout[],
  kernel: (slots: Float32Array, ...rest: Rest) => void,
): (fields: FieldBuffers, ...rest: Rest) => void {
  const slot = slotOf(buffers);
  return (fields, ...rest) => {
    // The longest field gives the run: a test may seed another one short.
    let count = 0;
    for (const field of slot.fields) {
      const array = fields[field.name] as Float32Array | undefined;
      if (array !== undefined) {
        count = Math.max(count, Math.floor(array.length / field.components));
      }
    }
    const slots = mergeFields(slot, fields, count);
    kernel(slots, ...rest);
    splitFields(slot, slots, fields);
  };
}

/**
 * The inverse of {@link overFields}: a kernel written over per-field arrays, called with slots laid
 * out by `buffers` - split into fields, run, and interleaved back - for a hand-written artifact.
 */
export function overSlots<Rest extends unknown[]>(
  buffers: readonly FXBufferLayout[],
  kernel: (fields: FieldBuffers, ...rest: Rest) => void,
): (slots: Float32Array, ...rest: Rest) => void {
  const slot = slotOf(buffers);
  return (slots, ...rest) => {
    const fields: FieldBuffers = {};
    splitFields(slot, slots, fields);
    kernel(fields, ...rest);
    slots.set(mergeFields(slot, fields, slots.length / slot.stride));
  };
}
