import { FX_CORE_LIFECYCLE } from "sparcoon";
import { slotLayout } from "sparcoon/editor";

import { buildFunction } from "../core/codegen/buildFunction.Internal";
import type {
  FXCompiledKernel,
  FXCompiledKernelPhase,
  FXKernelBufferLayout,
  FXKernelWrite,
} from "./FXCompiledKernel";
import { deadSlotJS, killStatementJS } from "./FXKernelLifecycle.Internal";
import type { FXParticleSpawnKernel, FXParticleUpdateKernel } from "./FXKernelShared.Internal";
import {
  bufferAccess,
  bufferBaseName,
  resourceNames,
  SPAWN_KERNEL_PARAMETERS,
  UPDATE_KERNEL_PARAMETERS,
} from "./FXKernelShared.Internal";

/**
 * The preview's assembly layer: turns a compiled {@link FXCompiledKernel} into executable
 * spawn/update JS (see `buildFunction`).
 */

/** Reads each captured binding and resource once into a local, ahead of the per-particle
 *  loop. */
function bindingPreamble(phase: FXCompiledKernelPhase): string {
  return [...Object.keys(phase.bindings), ...resourceNames(phase)]
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

/**
 * Skips a dead slot (`age >= lifetime`, a never-born slot's zeroed lifecycle included) in the
 * update, as the GPU pass leaves it untouched: its state is never shown, and a birth zero-fills it.
 */
function deadSlotSkip(phase: FXCompiledKernelPhase): readonly string[] {
  if (!phase.buffers.some((buffer) => buffer.name === FX_CORE_LIFECYCLE)) {
    return [];
  }
  return [`  if (${deadSlotJS()}) continue;`];
}

/** Assembles the per-particle loop body shared by both phases' `new Function` source. */
function phaseLoopBody(phase: FXCompiledKernelPhase, kind: FXKernelPhaseKind): string {
  return [
    bufferBaseDecls(phase.buffers),
    ...(kind === "update" ? deadSlotSkip(phase) : []),
    indented(phase.preamble),
    ...phase.body.map((line) => `  ${line}`),
    writeStatements(phase.writes),
    indented(phase.epilogue),
    // Last, so a kill sees this update's writes.
    ...(phase.kill === undefined ? [] : [`  ${killStatementJS(phase.kill)}`]),
  ].join("\n");
}

/** Which phase a body runs: the update over every drawn slot, or the spawn over the born rows. */
export type FXKernelPhaseKind = "spawn" | "update";

/** The `for (...)` header of each phase. */
const LOOP_HEADERS: Readonly<Record<FXKernelPhaseKind, string>> = {
  update: "for (let i = 0; i < count; i++) {",
  spawn: "for (let i = start; i < start + count; i++) {",
};

/**
 * The runnable body of a compiled phase. Shared verbatim by the preview's builders here and the
 * module emitter, so both run the same code, calling the same helpers.
 */
export function assembleKernelBody(phase: FXCompiledKernelPhase, kind: FXKernelPhaseKind): string {
  return [
    bindingPreamble(phase),
    // Particle-invariant locals, computed once per invocation before the loop.
    ...phase.preLoop,
    LOOP_HEADERS[kind],
    phaseLoopBody(phase, kind),
    "}",
  ].join("\n");
}

export function buildParticleUpdateKernel(compiled: FXCompiledKernel): FXParticleUpdateKernel {
  const phase = compiled.update;
  return buildFunction(
    phase.helpers,
    UPDATE_KERNEL_PARAMETERS,
    assembleKernelBody(phase, "update"),
  ) as FXParticleUpdateKernel;
}

/** Runs over the freshly born rows `[start, start + count)` at birth. */
export function buildParticleSpawnKernel(compiled: FXCompiledKernel): FXParticleSpawnKernel {
  const phase = compiled.spawn;
  if (phase === undefined) {
    throw new Error("buildParticleSpawnKernel: compiled kernel has no spawn phase");
  }
  return buildFunction(
    phase.helpers,
    SPAWN_KERNEL_PARAMETERS,
    assembleKernelBody(phase, "spawn"),
  ) as FXParticleSpawnKernel;
}
