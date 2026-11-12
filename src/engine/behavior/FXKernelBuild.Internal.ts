import { slotLayout } from "sparcoon/editor";

import type {
  FXCompiledKernel,
  FXCompiledKernelPhase,
  FXKernelBindingHandle,
  FXKernelBufferLayout,
  FXKernelWrite,
} from "./FXCompiledKernel";
import { killStatementJS } from "./FXKernelLifecycle.Internal";
import type { FXParticleSpawnKernel, FXParticleUpdateKernel } from "./FXKernelShared.Internal";
import { bufferAccess, bufferBaseName, SLOTS_PARAMETER } from "./FXKernelShared.Internal";

/**
 * The `new Function` assembly layer: turns a compiled {@link FXCompiledKernel} into executable
 * spawn/update JS. Split out of `FXParticleBehaviorKernel.Internal`; depends only on the
 * compiled data and the shared buffer helpers.
 */

/** Reads each captured binding once into a local, ahead of the per-particle loop. */
function bindingPreamble(bindings: Readonly<Record<string, FXKernelBindingHandle>>): string {
  return Object.keys(bindings)
    .map((name) => `const ${name} = bindings[${JSON.stringify(name)}].value;`)
    .join("\n");
}

/** Declares where every buffer's field of the current particle starts in the slots, at the top of
 *  the loop: the particle's slot, then the field's place in it (`slotLayout`, as the runtime lays
 *  the slot out). */
function bufferBaseDecls(buffers: readonly FXKernelBufferLayout[]): string {
  const slot = slotLayout(
    buffers.map((buffer) => ({ name: buffer.name, components: buffer.stride })),
  );
  return slot.fields
    .map(
      (field) =>
        `  const ${bufferBaseName(field.name)} = i * ${slot.stride.toString()} + ${field.offset.toString()};`,
    )
    .join("\n");
}

/** Emits the resolved state writes, indented for the per-particle loop body. */
function writeStatements(writes: readonly FXKernelWrite[]): string {
  return writes
    .map((write) => `  ${bufferAccess(write.buffer, write.offset)} = ${write.expr};`)
    .join("\n");
}

/** Indents a list of target-provided loop statements. */
function indented(lines: readonly string[]): string {
  return lines.map((line) => `  ${line}`).join("\n");
}

/** Assembles the per-particle loop body shared by both phases' `new Function` source. */
function phaseLoopBody(phase: FXCompiledKernelPhase): string {
  return [
    bufferBaseDecls(phase.buffers),
    indented(phase.preamble),
    ...phase.body.map((line) => `  ${line}`),
    writeStatements(phase.writes),
    indented(phase.epilogue),
    // Last, so a kill sees this update's writes.
    ...(phase.kill === undefined ? [] : [`  ${killStatementJS(phase.kill)}`]),
  ].join("\n");
}

/**
 * The runnable body of a compiled phase, excluding helper definitions. Shared verbatim by
 * the `new Function` builders here and the editor's module emitter (which hoists helpers to
 * module scope instead), so both execute byte-identical logic.
 */
export function assembleKernelBody(phase: FXCompiledKernelPhase, loopHeader: string): string {
  return [
    bindingPreamble(phase.bindings),
    // Particle-invariant locals, computed once per invocation before the loop.
    ...phase.preLoop,
    loopHeader,
    phaseLoopBody(phase),
    "}",
  ].join("\n");
}

/** The `for (...)` header for the update phase (every live particle). */
export const UPDATE_LOOP_HEADER = "for (let i = 0; i < count; i++) {";

/** The `for (...)` header for the spawn phase (the freshly born rows). */
export const SPAWN_LOOP_HEADER = "for (let i = start; i < start + count; i++) {";

export function buildParticleUpdateKernel(compiled: FXCompiledKernel): FXParticleUpdateKernel {
  const phase = compiled.update;
  const source = [...phase.helpers, assembleKernelBody(phase, UPDATE_LOOP_HEADER)].join("\n");
  const built = new Function(
    SLOTS_PARAMETER,
    "count",
    "dt",
    "bindings",
    "emitter",
    source,
  ) as unknown;
  return built as FXParticleUpdateKernel;
}

/** Runs over the freshly born rows `[start, start + count)` at birth. */
export function buildParticleSpawnKernel(compiled: FXCompiledKernel): FXParticleSpawnKernel {
  const phase = compiled.spawn;
  if (phase === undefined) {
    throw new Error("buildParticleSpawnKernel: compiled kernel has no spawn phase");
  }
  const source = [...phase.helpers, assembleKernelBody(phase, SPAWN_LOOP_HEADER)].join("\n");
  const built = new Function(
    SLOTS_PARAMETER,
    "start",
    "count",
    "bindings",
    "emitter",
    source,
  ) as unknown;
  return built as FXParticleSpawnKernel;
}
