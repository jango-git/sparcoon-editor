import type {
  FXCompiledKernel,
  FXCompiledKernelPhase,
  FXKernelBindingDescriptor,
  FXKernelBindingHandle,
  FXKernelBufferLayout,
  FXKernelIntegration,
  FXKernelLocal,
  FXKernelWrite,
} from "./FXCompiledKernel";
import type { FXValidationResult } from "../core/compiler/FXCompilerError";
import { FXCompilerErrorException } from "../core/compiler/FXCompilerError";
import { FXCompileContextBase } from "../core/compiler/FXCompileContextBase";
import {
  buildNodes,
  prepareCompile,
  throwIfInvalid,
} from "../core/compiler/compileDriver.Internal";
import type { FXKernelContext } from "./FXKernelContext";
import type { FXValueParam } from "../core/compiler/FXCompilerContext";
import { outputSocket } from "../core/compiler/FXSocketIndex.Internal";
import { structuralHash } from "../core/compiler/FXStructuralHash.Internal";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import { FXBehaviorPhase } from "./FXBehaviorPhase";
import type { FXGraph } from "../core/FXGraph";
import { socketRefKey } from "../core/socket/FXSocket";
import type { FXExpr } from "../core/ir/FXExpr";
import { construct, createBuilders, ref } from "../core/ir/FXExprBuilder";
import { signaturesFrom } from "../core/ir/FXFunctions.Internal";
import type { FXValueType } from "../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../core/socket/FXValueType";
import { scalarize, scalarComponentName } from "../core/codegen/scalarize.Internal";
import {
  commonSubexpressionElimination,
  partitionByInvariance,
} from "../core/codegen/cse.Internal";
import { printJS } from "../core/codegen/printJS.Internal";
import { uniqueIdentifier } from "../core/codegen/uniqueName.Internal";
import type {
  FXBehaviorTargets,
  FXKernelTarget,
  FXKernelTargetOutput,
} from "./FXParticleBehaviorTarget";
import { buildParticleBehaviorTargets } from "./FXParticleBehaviorTarget";
import { collectAttributeRequests } from "../core/compiler/collectAttributeRequests";
import { behaviorTargetsSignature } from "./FXKernelTargetSignature.Internal";
import { BUILTIN_BUFFER, FX_BEHAVIOR_ALL_FUNCTIONS } from "./FXKernelShared.Internal";
import {
  buildPhaseView,
  resolvePlacementPhases,
  validateBehavior,
} from "./FXKernelValidation.Internal";
import {
  generateEpilogue,
  isInvariantKernelRef,
  resolveKernelRef,
} from "./FXKernelRefResolve.Internal";
import { behaviorNodeKey, previewBehaviorHash } from "./FXKernelStructuralHash.Internal";

// This module is the behavior compile family's entry point; re-export the public symbols that
// moved to the split files so existing importers keep their one import path.
export type {
  FXKernelBuffers,
  FXEmitterTransform,
  FXParticleUpdateKernel,
  FXParticleSpawnKernel,
} from "./FXKernelShared.Internal";
export { resolvePlacementPhases, validateBehavior } from "./FXKernelValidation.Internal";
export {
  assembleKernelBody,
  buildParticleSpawnKernel,
  buildParticleUpdateKernel,
  SPAWN_LOOP_HEADER,
  UPDATE_LOOP_HEADER,
} from "./FXKernelBuild.Internal";
export { previewBehaviorHash } from "./FXKernelStructuralHash.Internal";

/** Component suffixes for a vector value param's per-component binding hints (`positionx`, ...). */
const VEC_COMPONENT_NAMES = ["x", "y", "z", "w"] as const;

/** Mutable accumulator for one phase's compilation (JS SSA). */
class FXKernelState {
  private counter = 0;
  private readonly preLoopLines: string[] = [];
  private readonly bodyLines: string[] = [];
  private readonly localsIR: FXKernelLocal[] = [];
  private readonly helperMap = new Map<string, string>();
  private readonly bindingHandles: FXKernelBindingHandle[] = [];

  public uniqueName(hint: string): string {
    // `$` is legal in a JS identifier but rejected by the kernel-target name lint,
    // so a generated local can never collide with a buffer-derived `s_`/`b_` local.
    const name = uniqueIdentifier(hint, "$", this.counter);
    this.counter += 1;
    return name;
  }

  /** Registers a materialized local's scalar AST into the phase plan (printed at {@link finalize}). */
  public recordLocal(name: string, expr: FXExpr): void {
    this.localsIR.push({ name, expr });
  }

  /**
   * Runs CSE over the accumulated SSA plan, splits it into particle-invariant (hoisted before
   * the loop) and per-particle locals, then prints each. Called once after every node's `build`
   * has registered its locals, so shared subtrees (a repeated `length`, a matrix determinant)
   * are deduped across the whole phase and invariants (bindings, `dt`, the emitter transform)
   * leave the hot loop.
   */
  public finalize(target: FXKernelTarget): void {
    const isImpureCall = (fn: string): boolean =>
      FX_BEHAVIOR_ALL_FUNCTIONS.get(fn)?.impure === true;
    const optimized = commonSubexpressionElimination(
      this.localsIR,
      (hint) => this.uniqueName(hint),
      isImpureCall,
    );
    const { preLoop, body } = partitionByInvariance(
      optimized,
      (ref) => isInvariantKernelRef(target, ref),
      isImpureCall,
    );
    const printInto = (locals: readonly FXKernelLocal[], destination: string[]): void => {
      for (const { name, expr } of locals) {
        const { code, helpers } = printJS(expr, FX_BEHAVIOR_ALL_FUNCTIONS, (candidate) =>
          resolveKernelRef(target, candidate),
        );
        for (const [key, source] of helpers) {
          this.emitHelper(key, source);
        }
        destination.push(`const ${name} = (${code});`);
      }
    };
    printInto(preLoop, this.preLoopLines);
    printInto(body, this.bodyLines);
  }

  public emitHelper(key: string, source: string): void {
    if (!this.helperMap.has(key)) {
      this.helperMap.set(key, source);
    }
  }

  public allocateBinding(descriptor: FXKernelBindingDescriptor): FXKernelBindingHandle {
    // A forced name (a param slot) is used verbatim and deduped: two param nodes of the same
    // name share one binding (timeline-addressable, survives structural edits). Else auto-number.
    if (descriptor.name !== undefined) {
      const existing = this.bindingHandles.find((handle) => handle.name === descriptor.name);
      if (existing !== undefined) {
        return existing;
      }
      const handle: FXKernelBindingHandle = { name: descriptor.name, value: descriptor.value };
      this.bindingHandles.push(handle);
      return handle;
    }
    const name = this.uniqueName(`b_${descriptor.hint ?? "binding"}`);
    const handle: FXKernelBindingHandle = { name, value: descriptor.value };
    this.bindingHandles.push(handle);
    return handle;
  }

  public assemblePhase(
    writes: readonly FXKernelWrite[],
    preamble: readonly string[],
    epilogue: readonly string[],
    integration: readonly FXKernelIntegration[],
    buffers: readonly FXKernelBufferLayout[],
  ): FXCompiledKernelPhase {
    const bindings: Record<string, FXKernelBindingHandle> = {};
    for (const handle of this.bindingHandles) {
      bindings[handle.name] = handle;
    }
    // Motion integration always lands in the builtin buffer; node writes name theirs.
    const written = new Set(writes.map((write) => write.buffer));
    if (integration.length > 0) {
      written.add(BUILTIN_BUFFER);
    }
    return {
      helpers: [...this.helperMap.values()],
      preLoop: this.preLoopLines,
      preamble,
      body: this.bodyLines,
      writes,
      epilogue,
      bindings,
      buffers,
      writtenBuffers: [...written],
    };
  }
}

/** Builder facade for the behavior backend - `call` resolves against core + behavior signatures. */
const BEHAVIOR_BUILDERS = createBuilders(signaturesFrom(FX_BEHAVIOR_ALL_FUNCTIONS));

/** {@link FXKernelContext} bound to one node; emits JS over the packed state. */
class FXParticleKernelContext
  extends FXCompileContextBase<FXBehaviorNode, readonly string[]>
  implements FXKernelContext
{
  public readonly builders = BEHAVIOR_BUILDERS;
  protected readonly contextLabel = "FXKernelContext";

  constructor(
    private readonly state: FXKernelState,
    graph: FXGraph<FXBehaviorNode>,
    node: FXBehaviorNode,
    nodeId: string,
    outputVariables: Map<string, readonly string[]>,
    private readonly target: FXKernelTarget,
    types: ReadonlyMap<string, FXValueType>,
  ) {
    super(graph, node, nodeId, outputVariables, types);
  }

  public get phase(): FXBehaviorPhase {
    return this.node.phase;
  }

  public setOutput(socketKey: string, expression: FXExpr): void {
    if (outputSocket(this.node, socketKey) === undefined) {
      throw new Error(
        `FXKernelContext.setOutput: node "${this.nodeId}" has no output socket "${socketKey}"`,
      );
    }
    const names = this.materialize(this.outputHint(socketKey), expression);
    this.outputVariables.set(socketRefKey({ nodeId: this.nodeId, socketKey }), names);
  }

  public defineLocal(hint: string, expression: FXExpr): FXExpr {
    const names = this.materialize(hint, expression);
    const [firstName] = names;
    if (names.length === 1 && firstName !== undefined) {
      return ref("local", firstName, expression.type);
    }
    return construct(
      expression.type,
      ...names.map((name) => ref("local", name, FX_VALUE_TYPES.float)),
    );
  }

  public readTargetInput(name: string): FXExpr {
    // Typed throws so a live apply repackages a third-party node's bad target read
    // with its code/nodeId intact, instead of a bare Error folded to compile-failed.
    const input = this.target.inputs.find((candidate) => candidate.name === name);
    if (input === undefined) {
      throw new FXCompilerErrorException({
        code: "unknown-target-input",
        message: `FXKernelContext.readTargetInput: target "${this.target.name}" provides no builtin "${name}"`,
        nodeId: this.nodeId,
      });
    }
    if (input.type.components <= 1) {
      return ref("targetInput", name, input.type);
    }
    // A buffer-backed vector must carry one offset per component; a host vector (no offsets,
    // e.g. the emitter transform) resolves to a runtime argument field instead, but expands
    // into per-component refs the same way. Only a mismatched offset table is malformed.
    if (input.offsets !== undefined && input.offsets.length !== input.type.components) {
      // A malformed target shape; normally caught pre-compile by validateKernelTarget.
      throw new FXCompilerErrorException({
        code: "unresolvable-target-input",
        message: `FXKernelContext.readTargetInput: builtin "${name}" is not a resolvable vector`,
        nodeId: this.nodeId,
        params: { name },
      });
    }
    // Each component is its own offset-encoded targetInput ref; resolveRef reads it.
    const components = [...Array(input.type.components).keys()].map((index) =>
      ref("targetInput", `${name}@${index.toString()}`, FX_VALUE_TYPES.float),
    );
    return construct(input.type, ...components);
  }

  public uniqueName(hint: string): string {
    return this.state.uniqueName(hint);
  }

  public emitHelper(key: string, source: string): void {
    this.state.emitHelper(key, source);
  }

  public allocateBinding(descriptor: FXKernelBindingDescriptor): FXKernelBindingHandle {
    return this.state.allocateBinding(descriptor);
  }

  /**
   * A scalar value param is one binding; a vector is one binding per component, referenced
   * through a `construct` (bindings are scalar). Edits publish by rewriting each binding value.
   */
  public allocateValueParam(
    type: FXValueType,
    value: number | readonly number[],
    hint: string,
  ): FXValueParam {
    if (type.components === 1) {
      const handle = this.allocateBinding({ value: value as number, hint });
      return {
        expr: ref("binding", handle.name, type),
        handle: {
          update: (next): void => {
            handle.value = next as number;
          },
        },
      };
    }
    const components = value as readonly number[];
    const handles = components.map((component, i) =>
      this.allocateBinding({ value: component, hint: `${hint}${VEC_COMPONENT_NAMES[i]}` }),
    );
    return {
      expr: construct(
        type,
        ...handles.map((handle) => ref("binding", handle.name, FX_VALUE_TYPES.float)),
      ),
      handle: {
        update: (next): void => {
          const componentValues = next as readonly number[];
          for (const [index, handle] of handles.entries()) {
            const componentValue = componentValues[index];
            if (componentValue === undefined) {
              throw new Error(
                "allocateValueParam: update value has fewer components than the binding",
              );
            }
            handle.value = componentValue;
          }
        },
      },
    };
  }

  /**
   * A scalar producer is one local ref; a vector is a `construct` over its component locals
   * (any names, no convention), matching how {@link materialize} stored them.
   */
  protected override materializeProducer(
    names: readonly string[],
    producerType: FXValueType,
  ): FXExpr {
    const [firstName] = names;
    return names.length === 1 && firstName !== undefined
      ? ref("local", firstName, producerType)
      : construct(
          producerType,
          ...names.map((componentName) => ref("local", componentName, FX_VALUE_TYPES.float)),
        );
  }

  /**
   * Scalarizes an expression into one SSA local per component and registers each into the
   * phase plan. Printing is **deferred** to {@link FXKernelState.finalize}, which runs CSE
   * over the whole plan before emitting - so a subtree shared across components (or across
   * nodes) is printed once. Returns the component local names for the caller to reference.
   */
  private materialize(hint: string, expression: FXExpr): string[] {
    const components = scalarize(expression);
    return components.map((component, index) => {
      // Component locals follow scalarComponentName so a later ref-expansion (same helper)
      // reconstructs the identical names; a scalar keeps the bare hint.
      const componentName = components.length === 1 ? hint : scalarComponentName(hint, index);
      const name = this.state.uniqueName(componentName);
      this.state.recordLocal(name, component);
      return name;
    });
  }
}

/** Compiles one already-isolated phase view into its {@link FXCompiledKernelPhase}. */
function compilePhase(
  view: FXGraph<FXBehaviorNode>,
  target: FXKernelTarget,
): FXCompiledKernelPhase {
  const { order, resolution } = prepareCompile(view);
  const state = new FXKernelState();
  const outputVariables = new Map<string, readonly string[]>();

  buildNodes(view, order, (node, id) => {
    node.build(
      new FXParticleKernelContext(state, view, node, id, outputVariables, target, resolution.types),
    );
  });

  const outputBySlot = new Map<string, FXKernelTargetOutput>(
    target.outputs.map((output): [string, FXKernelTargetOutput] => [output.slot, output]),
  );
  const writes: FXKernelWrite[] = [];
  for (const binding of view.outputBindings) {
    const producer = outputVariables.get(socketRefKey(binding.from));
    const output = outputBySlot.get(binding.slot);
    if (producer === undefined || output === undefined) {
      continue;
    }
    const buffer = output.buffer ?? BUILTIN_BUFFER;
    const [firstComponent] = producer;
    if (firstComponent === undefined) {
      throw new Error("compilePhase: output producer has no components");
    }
    // Numeric coercion into the slot mirrors `coerceNumeric`: a scalar producer
    // splats across every slot component; a narrower vector pads its missing tail
    // with 0; a wider producer's extra components are simply not written.
    for (const [index, offset] of output.offsets.entries()) {
      const expr = producer.length === 1 ? firstComponent : (producer[index] ?? "0.0");
      writes.push({ buffer, offset, expr });
    }
  }

  // All nodes have registered their locals; print the phase once, after CSE dedups shared
  // subtrees across the whole plan.
  state.finalize(target);

  const integration = target.integration ?? [];
  const epilogue = generateEpilogue(integration, target);
  return state.assemblePhase(writes, target.preamble ?? [], epilogue, integration, target.buffers);
}

/**
 * Compiles a two-phase behavior graph into an {@link FXCompiledKernel}. Validates
 * first (throws on invalid), then splits the graph by node phase and compiles each
 * phase view against its target. The structural hash covers the whole graph.
 */
export function compileBehavior(
  graph: FXGraph<FXBehaviorNode>,
  targets: FXBehaviorTargets,
): FXCompiledKernel {
  // Carry the first structured error (code/nodeId) instead of a bare Error, so a caller
  // catching this throw keeps the classification.
  throwIfInvalid(validateBehavior(graph, targets));

  const { order, resolution } = prepareCompile(graph);
  const phases = resolvePlacementPhases(graph, targets, order);
  const phaseOf = (id: string): FXBehaviorPhase =>
    phases.get(id) ?? graph.getNode(id)?.phase ?? FXBehaviorPhase.UPDATE;

  const spawn =
    targets.spawn !== undefined
      ? compilePhase(buildPhaseView(graph, FXBehaviorPhase.SPAWN, phaseOf), targets.spawn)
      : undefined;
  const update = compilePhase(
    buildPhaseView(graph, FXBehaviorPhase.UPDATE, phaseOf),
    targets.update,
  );

  const hash = structuralHash(
    graph,
    behaviorTargetsSignature(targets),
    order,
    behaviorNodeKey(resolution.types, phases),
  );

  return { ...(spawn !== undefined ? { spawn } : {}), update, hash };
}

/**
 * The standard particle phase targets extended with the graph's own declared attributes
 * (`store-attribute`/`read-attribute`) - velocity/scale/rotation/torque/seed are now ordinary
 * attributes, so the plain core-only targets would reject their `attr:<name>` slots.
 */
function particleTargetsFor(graph: FXGraph<FXBehaviorNode>): FXBehaviorTargets {
  return buildParticleBehaviorTargets(collectAttributeRequests(graph).requests);
}

/** Validates the graph against the built-in particle targets (with its attributes). */
export function validateParticleBehavior(graph: FXGraph<FXBehaviorNode>): FXValidationResult {
  return validateBehavior(graph, particleTargetsFor(graph));
}

/** Structural hash of the graph against the built-in particle targets (with its attributes). */
export function previewParticleBehaviorHash(graph: FXGraph<FXBehaviorNode>): string {
  return previewBehaviorHash(graph, particleTargetsFor(graph));
}

/** Compiles the graph against the built-in particle targets (with its attributes). */
export function compileParticleBehavior(graph: FXGraph<FXBehaviorNode>): FXCompiledKernel {
  return compileBehavior(graph, particleTargetsFor(graph));
}
