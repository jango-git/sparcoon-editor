import { byJSON } from "../core/compiler/targetLint.Internal";
import type { FXExpr } from "../core/ir/FXExpr";
import { childrenOf } from "../core/ir/visit.Internal";
import type { FXBehaviorTargets, FXKernelTarget } from "./FXParticleBehaviorTarget";

/**
 * A compact structural encoding of an expression tree (for integration steps); recursion goes
 * through {@link childrenOf}, so a new IR kind needs only its head case here plus `childrenOf`.
 */
function exprSignature(expr: FXExpr): string {
  const children = childrenOf(expr).map(exprSignature).join(",");
  switch (expr.kind) {
    case "lit":
      return `L${expr.type.id}(${expr.values.join(",")})`;
    case "ref":
      return `R${expr.ref}:${expr.name}:${expr.type.id}`;
    case "bin":
      return `B${expr.op}(${children})`;
    case "un":
      return `U${expr.op}(${children})`;
    case "call":
      return `C${expr.fn}(${children})`;
    case "swizzle":
      return `S${expr.channels}(${children})`;
    case "column":
      return `X${expr.index.toString()}(${children})`;
    case "construct":
      return `N${expr.type.id}(${children})`;
    case "select":
      return `?(${children})`;
    case "raw":
      return `W${expr.language}:${expr.code}(${children})`;
  }
}

/** A canonical, order-independent string capturing a behavior {@link FXKernelTarget}'s whole shape. */
function kernelTargetSignature(target: FXKernelTarget): string {
  // A field left out here lets a host re-shape its target without forcing a recompile (a stale
  // kernel keeps running); `satisfies` over this keyed object makes a new FXKernelTarget field
  // a compile error here until it is folded in.
  const parts = {
    name: target.name,
    buffers: target.buffers.map((buffer) => [buffer.name, buffer.stride]).sort(byJSON),
    // Array position, not an object key: JSON.stringify already turns an `undefined` element
    // into `null`, so no `?? null` fallback is needed to keep the encoding stable.
    inputs: target.inputs
      .map((input) => [input.name, input.type.id, input.offsets, input.buffer])
      .sort(byJSON),
    outputs: target.outputs
      .map((output) => [
        output.slot,
        output.type.id,
        output.offsets,
        output.required,
        output.buffer,
      ])
      .sort(byJSON),
    // Preamble lines are spliced verbatim into the compiled loop - order matters,
    // so they are folded as-is, unsorted.
    preamble: target.preamble ?? [],
    integration: (target.integration ?? [])
      .map((step) => [step.offset, exprSignature(step.expr)])
      .sort(byJSON),
  } satisfies Record<keyof FXKernelTarget, unknown>;
  return JSON.stringify([
    "kernel",
    parts.name,
    parts.buffers,
    parts.inputs,
    parts.outputs,
    parts.preamble,
    parts.integration,
  ]);
}

/**
 * Structural signature of both phase targets, folded into the behavior hash in place of the
 * bare target names, so a re-shaped target (without renaming) forces a recompile.
 */
export function behaviorTargetsSignature(targets: FXBehaviorTargets): string {
  // `satisfies` over this keyed object makes a new FXBehaviorTargets field a compile error here
  // until it is folded in - the same discipline kernelTargetSignature already applies above.
  const parts = {
    // Array position in the return below, not an object key: JSON.stringify already turns an
    // `undefined` element into `null`, so no explicit fallback is needed.
    spawn: targets.spawn === undefined ? undefined : kernelTargetSignature(targets.spawn),
    update: kernelTargetSignature(targets.update),
    // Coerced to a real boolean: undefined (a hand-built target with no GPU concept) and false
    // must hash identically - both mean "no optional simulation family attempted".
    tryGpuSimulation: targets.tryGpuSimulation === true,
  } satisfies Record<keyof FXBehaviorTargets, unknown>;
  return JSON.stringify(["behavior", parts.spawn, parts.update, parts.tryGpuSimulation]);
}
