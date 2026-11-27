import {
  FX_CORE_LIFECYCLE,
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
} from "sparcoon";

import type { FXCompiledDrawStage, FXTypedLocal } from "../core/codegen/drawStage.Internal";
import { liftDrawStage } from "../core/codegen/drawStage.Internal";
import { withoutDeadLocals } from "../core/codegen/liveness.Internal";
import { printGLSLStandard } from "../core/codegen/printGLSLStandard.Internal";
import { classifyRates } from "../core/codegen/rates.Internal";
import { FXGLSLNames } from "../core/codegen/uniqueName.Internal";
import {
  buildNodes,
  prepareCompile,
  throwIfInvalid,
} from "../core/compiler/compileDriver.Internal";
import { FXCompileContextBase } from "../core/compiler/FXCompileContextBase";
import type { FXValueParam } from "../core/compiler/FXCompilerContext";
import type { FXValidationResult } from "../core/compiler/FXCompilerError";
import { outputSocket } from "../core/compiler/FXSocketIndex.Internal";
import { structuralHash } from "../core/compiler/FXStructuralHash.Internal";
import { socketConcreteType } from "../core/compiler/FXTypeResolve.Internal";
import type { FXGraph } from "../core/FXGraph";
import type { FXExpr } from "../core/ir/FXExpr";
import type { FXExprBuilderApi } from "../core/ir/FXExprBuilder";
import { coerceNumeric, construct, createBuilders, ref } from "../core/ir/FXExprBuilder";
import { FX_FUNCTIONS, signaturesFrom } from "../core/ir/FXFunctions.Internal";
import { collectGLSLHelper, type FXGLSLHelperName } from "../core/ir/FXHelpers.Internal";
import { FX_ASSET_KINDS, type FXAssetKind } from "../core/nodes/FXAssetKind";
import { socketRefKey } from "../core/socket/FXSocket";
import type { FXValueType } from "../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../core/socket/FXValueType";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import { FXBehaviorPhase } from "./FXBehaviorPhase";
import type {
  FXKernelBindingDescriptor,
  FXKernelBindingHandle,
  FXKernelBufferLayout,
  FXKernelResourceFields,
  FXKernelWrite,
} from "./FXCompiledKernel";
import type { FXKernelContext } from "./FXKernelContext";
import { KERNEL_RATE, kernelDrawInputs, kernelRatePolicy } from "./FXKernelDrawInputs.Internal";
import { BUILTIN_BUFFER, FXKernelResources, type FXResourceReads } from "./FXKernelShared.Internal";
import { behaviorNodeKey } from "./FXKernelStructuralHash.Internal";
import { behaviorTargetsSignature } from "./FXKernelTargetSignature.Internal";
import {
  type FXKernelUniform,
  inheritedUniform,
  inheritedUniformRead,
  SCENE_DEPTH_UNIFORMS,
  transformFeedbackUniformBudget,
} from "./FXKernelUniformsStandard.Internal";
import {
  buildPhaseView,
  resolvePlacementPhases,
  validateBehavior,
} from "./FXKernelValidation.Internal";
import type {
  FXBehaviorTargets,
  FXKernelTarget,
  FXKernelTargetOutput,
} from "./FXParticleBehaviorTarget";
import type { FXEmitterTransformField, FXKernelHostParameter } from "./FXParticleBehaviorTarget";

/**
 * The standard-tier (WebGL2, transform-feedback) behavior compiler. It does not scalarize, since
 * GLSL has vectors. Values that depend only on the pass (dt, emitter transform, bindings) move to
 * the draw stage and arrive as uniforms. Produces one {@link FXCompiledPhaseStandard} per phase,
 * fused by `FXKernelBuildStandard.Internal.ts`.
 */

/** GLSL-safe swizzle channel for offset `0..3`. */
const SWIZZLE_CHANNELS = ["x", "y", "z", "w"] as const;

const FLOAT = FX_VALUE_TYPES.float;

const VEC_COMPONENT_NAMES = ["x", "y", "z", "w"] as const;

/**
 * Core registry only. A JS-only function (`sampleLut`) then throws "unknown function" at build time
 * instead of failing at shader link.
 */
const STANDARD_BEHAVIOR_BUILDERS: FXExprBuilderApi = createBuilders(signaturesFrom(FX_FUNCTIONS));

/**
 * GLSL `in` attribute name of a state buffer. Shared with the assembler. The runtime binds by
 * `layout(location)` index, not by name.
 */
export function glslBufferAttributeName(bufferName: string): string {
  return `in_${bufferName}`;
}

/**
 * The local a spawn target's slot reads resolve to instead of the `in` attribute, which holds the
 * slot's previous particle: the newborn's own slot, which the fused program's birth branch
 * declares ahead of the spawn body (`FXKernelBuildStandard`).
 */
export function glslNewbornSlotName(bufferName: string): string {
  return `fx_newborn_${bufferName}`;
}

/** The newborn's age and the model matrix as of its birth: locals the fused program's birth branch
 *  declares ahead of the spawn body (`FXKernelBuildStandard`), what an at-birth model-matrix read
 *  resolves to. */
export const BIRTH_AGE_LOCAL = "fx_birthAge";
export const BIRTH_MODEL_MATRIX_LOCAL = "fx_birthModelMatrix";

/**
 * The caller's values as the fixed uniforms of the runtime's transform-feedback layout, imported
 * from there.
 */
const HOST_PARAMETER_UNIFORMS: Readonly<Record<FXKernelHostParameter, string>> = {
  dt: FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  seed: FX_TRANSFORM_FEEDBACK_RAND_SEED_UNIFORM,
};
const EMITTER_FIELD_UNIFORMS: Readonly<Record<FXEmitterTransformField, string>> = {
  worldMatrix: FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  velocity: FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  angularVelocity: FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
};

/**
 * One compiled GLSL phase, the input to the fused program. Uniform declarations are kept as text
 * because GLSL needs each binding's type.
 */
export interface FXCompiledPhaseStandard extends FXKernelResourceFields {
  /** The helpers the phase calls, each behind the ones it calls. */
  readonly helpers: readonly FXGLSLHelperName[];
  /** The uniforms this phase declares: its bindings, then its draw uniforms. */
  readonly uniforms: readonly FXKernelUniform[];
  readonly body: readonly string[];
  readonly writes: readonly FXKernelWrite[];
  /** The bound kill value (a float variable); update phase only. */
  readonly kill?: string;
  /** Its resources are declared uniforms too (see {@link FXKernelResourceFields}), not bindings. */
  readonly bindings: Readonly<Record<string, FXKernelBindingHandle>>;
  readonly buffers: readonly FXKernelBufferLayout[];
  readonly writtenBuffers: readonly string[];
  /** What is one for the whole pass, computed once per pass on the CPU (see `liftDrawStage`). */
  readonly draw?: FXCompiledKernelDrawStage;
  /** Whether it reads the scene depth (a node {@link FXGraphNode.readsSceneDepth}); absent when not. */
  readonly sceneDepth?: true;
}

/** A phase's draw stage: `compute`'s body, and the draw uniforms it fills, by type. */
export interface FXCompiledKernelDrawStage {
  readonly stage: FXCompiledDrawStage;
  readonly uniforms: Readonly<Record<string, FXValueType>>;
}

/** A buffer write a phase's output slot makes, before placement names what it reads. */
interface FXPendingWrite {
  readonly buffer: string;
  readonly offset: number;
  readonly variable: string;
  /** The component of `variable` written, for a vector slot; none for a scalar one. */
  readonly channel?: string | undefined;
}

export interface FXCompiledKernelStandard {
  readonly spawn?: FXCompiledPhaseStandard;
  readonly update: FXCompiledPhaseStandard;
  readonly hash: string;
}

/** Accumulator for one phase: locals are kept as IR and printed once the phase is built. */
class FXKernelStateStandard {
  /** Each local as its node emitted it: kept as IR until {@link assemblePhase} prints it. */
  private readonly locals: FXTypedLocal[] = [];
  private readonly helpers = new Set<FXGLSLHelperName>();
  private readonly uniforms: FXKernelUniform[] = [];
  private readonly bindingHandles: FXKernelBindingHandle[] = [];
  private readonly resources = new FXKernelResources();
  private resourceReads: FXResourceReads | undefined;
  private readsSceneDepth = false;

  /** `names` is the fused program's: shared with the other phase, whose uniforms sit beside
   *  this phase's in one program. */
  constructor(private readonly names: FXGLSLNames) {}

  /** The uniforms declared so far: the bindings, then (once placed) the draw uniforms. */
  public get declared(): readonly FXKernelUniform[] {
    return this.uniforms;
  }

  /** Allocates a collision-free, compact GLSL identifier (see {@link FXGLSLNames}). */
  public uniqueName(): string {
    return this.names.next();
  }

  /** Adds a local; {@link assemblePhase} prints it. */
  public emitLocal(name: string, expr: FXExpr): void {
    this.locals.push({ name, expr, type: expr.type });
  }

  public emitHelper(helper: FXGLSLHelperName): void {
    collectGLSLHelper(this.helpers, "standard", helper);
  }

  /** Declares a live-tunable `uniform float`, deduped by a forced name (a param slot) the same way
   *  the JS backend dedupes bindings; two allocations of the same name share one uniform. */
  public allocateBinding(descriptor: FXKernelBindingDescriptor): FXKernelBindingHandle {
    if (descriptor.name !== undefined) {
      const existing = this.bindingHandles.find((handle) => handle.name === descriptor.name);
      if (existing !== undefined) {
        return existing;
      }
    }
    const name = descriptor.name ?? this.uniqueName();
    this.declareUniform({ name, glslTypeName: "float" });
    const handle: FXKernelBindingHandle = { name, value: descriptor.value };
    this.bindingHandles.push(handle);
    return handle;
  }

  /** The sampler uniform asset `name` of `kind` is read through - the runtime binds a texture to
   *  it and sets the inputs beside it, not values it uploads, so no binding. Declared, with the
   *  inputs the code reads, by {@link declareResources}. */
  public allocateAsset(kind: FXAssetKind, name: string): string {
    return this.resources.nameOf(kind, name, () => this.uniqueName());
  }

  /** Declares the uniforms of the resources the locals `roots` (what the phase writes) read, once
   *  every node has emitted its locals. */
  public declareResources(roots: Iterable<string>): void {
    this.resourceReads = this.resources.readIn(
      withoutDeadLocals(this.locals, roots).map((local) => local.expr),
    );
    for (const uniform of this.resourceReads.declarations) {
      this.declareUniform(uniform);
    }
  }

  /**
   * Places the phase's locals and prints them: what is one for the whole pass goes to the draw
   * stage, computed once per pass on the CPU, as far as the program's uniforms allow beside
   * `otherDeclarations` (the uniforms the other phase declares); the rest runs per particle.
   */
  public assemblePhase(
    target: FXKernelTarget,
    pendingWrites: readonly FXPendingWrite[],
    buffers: readonly FXKernelBufferLayout[],
    killVariable: string | undefined,
    otherUniforms: readonly FXKernelUniform[],
  ): FXCompiledPhaseStandard {
    const drawUniforms: Record<string, FXValueType> = {};
    const lifted = liftDrawStage(
      [this.locals],
      [
        new Set([
          ...pendingWrites.map((write) => write.variable),
          ...(killVariable === undefined ? [] : [killVariable]),
        ]),
      ],
      classifyRates(this.locals, kernelRatePolicy(target)),
      {
        ...kernelDrawInputs(target),
        rate: KERNEL_RATE.pass,
        // A pass runs the kernel once a particle, as often as a vertex stage runs per draw.
        minimumCost: [3],
        fits: transformFeedbackUniformBudget([...otherUniforms, ...this.uniforms]),
        declareUniform: (type) => {
          const name = this.uniqueName();
          this.declareUniform({ name, glslTypeName: type.glslTypeName });
          drawUniforms[name] = type;
          return name;
        },
      },
    );
    const read = (variable: string): string => lifted.renamed.get(variable) ?? variable;
    const writes: FXKernelWrite[] = pendingWrites.map((write) => ({
      buffer: write.buffer,
      offset: write.offset,
      expr:
        write.channel === undefined
          ? read(write.variable)
          : `${read(write.variable)}.${write.channel}`,
    }));
    const kill = killVariable === undefined ? undefined : read(killVariable);
    const [locals = []] = lifted.stages;
    const body = locals.map((local) => {
      const { code, helpers } = printGLSLStandard(local.expr, FX_FUNCTIONS, (candidate) =>
        resolveKernelRefStandard(target, candidate),
      );
      for (const helper of helpers) {
        this.helpers.add(helper);
      }
      return `${local.type.glslTypeName} ${local.name} = ${code};`;
    });
    const bindings: Record<string, FXKernelBindingHandle> = {};
    for (const handle of this.bindingHandles) {
      bindings[handle.name] = handle;
    }
    const written = new Set(writes.map((write) => write.buffer));
    if (kill !== undefined) {
      written.add(FX_CORE_LIFECYCLE);
    }
    return {
      helpers: [...this.helpers],
      uniforms: this.uniforms,
      body,
      writes,
      ...(kill === undefined ? {} : { kill }),
      bindings,
      ...this.resourceReads?.fields,
      buffers,
      writtenBuffers: [...written],
      ...(lifted.stage === undefined
        ? {}
        : { draw: { stage: lifted.stage, uniforms: drawUniforms } }),
      ...(this.readsSceneDepth ? { sceneDepth: true } : {}),
    };
  }

  /** Declares a uniform of the runtime's contract this phase needs, such as the inherited one. */
  public declareContractUniform(uniform: FXKernelUniform): void {
    this.uniforms.push(uniform);
  }

  /** Declares the scene depth's contract uniforms, for a phase with a node reading it. */
  public declareSceneDepth(): void {
    this.readsSceneDepth = true;
    for (const uniform of SCENE_DEPTH_UNIFORMS) {
      this.declareContractUniform(uniform);
    }
  }

  private declareUniform(uniform: FXKernelUniform): void {
    this.uniforms.push(uniform);
  }
}

class FXParticleKernelContextStandard
  extends FXCompileContextBase<FXBehaviorNode, string>
  implements FXKernelContext
{
  public readonly builders = STANDARD_BEHAVIOR_BUILDERS;
  protected readonly contextLabel = "FXKernelContextStandard";

  constructor(
    private readonly state: FXKernelStateStandard,
    graph: FXGraph<FXBehaviorNode>,
    node: FXBehaviorNode,
    nodeId: string,
    outputVariables: Map<string, string>,
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
        `FXKernelContextStandard.setOutput: node "${this.nodeId}" has no output socket "${socketKey}"`,
      );
    }
    const key = socketRefKey({ nodeId: this.nodeId, socketKey });
    if (expression.kind === "ref" && expression.ref === "local") {
      // Already a local: consumers read it, with no alias of it in between.
      this.outputVariables.set(key, expression.name);
      return;
    }
    const name = this.state.uniqueName();
    this.state.emitLocal(name, expression);
    this.outputVariables.set(key, name);
  }

  public defineLocal(_hint: string, expression: FXExpr): FXExpr {
    const name = this.state.uniqueName();
    this.state.emitLocal(name, expression);
    return ref("local", name, expression.type);
  }

  public readTargetInput(name: string): FXExpr {
    const input = this.target.inputs.find((candidate) => candidate.name === name);
    if (input === undefined) {
      throw new Error(
        `FXKernelContextStandard.readTargetInput: target "${this.target.name}" provides no builtin "${name}"`,
      );
    }
    // Unlike the JS backend, a vector target input is never expanded into per-component refs -
    // the resolver below maps the whole name straight to a natively vector-typed `in` attribute.
    return ref("targetInput", name, input.type);
  }

  public uniqueName(): string {
    return this.state.uniqueName();
  }

  public emitHelper(helper: FXGLSLHelperName): void {
    this.state.emitHelper(helper);
  }

  // One binding per component, as on the JS backend. Costs one `gl.uniform1f` per component instead
  // of one `uniform3fv`.
  public allocateBinding(descriptor: FXKernelBindingDescriptor): FXKernelBindingHandle {
    return this.state.allocateBinding(descriptor);
  }

  public allocateAsset(kind: FXAssetKind, name: string): FXExpr {
    return ref("binding", this.state.allocateAsset(kind, name), FX_ASSET_KINDS[kind].sampler);
  }

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
      expr: construct(type, ...handles.map((handle) => ref("binding", handle.name, FLOAT))),
      handle: {
        update: (next): void => {
          const componentValues = next as readonly number[];
          handles.forEach((handle, i) => {
            const component = componentValues[i];
            if (component === undefined) {
              throw new Error(
                "FXParticleKernelContextStandard.allocateValueParam: update value has fewer components than declared",
              );
            }
            handle.value = component;
          });
        },
      },
    };
  }

  /** A producer is always one native-typed local - GLSL has no per-component decomposition to
   *  reconstruct (unlike the JS backend's `construct`-of-scalar-locals shape). */
  protected override materializeProducer(stored: string, producerType: FXValueType): FXExpr {
    return ref("local", stored, producerType);
  }
}

/** One phase built but not yet placed: its own uniforms so far, and how to place and print it. */
interface FXBuiltPhaseStandard {
  /** Its bindings; placement adds its draw uniforms. */
  readonly uniforms: readonly FXKernelUniform[];
  /** Places and prints the phase beside `otherUniforms`, the other phase's uniforms. */
  assemble(otherUniforms: readonly FXKernelUniform[]): FXCompiledPhaseStandard;
}

/** Builds one already-isolated phase view's nodes; {@link FXBuiltPhaseStandard.assemble} places them. */
function buildPhaseStandard(
  view: FXGraph<FXBehaviorNode>,
  target: FXKernelTarget,
  names: FXGLSLNames,
): FXBuiltPhaseStandard {
  const { order, resolution } = prepareCompile(view);
  const state = new FXKernelStateStandard(names);
  const inherited = inheritedUniform(target.inherit?.layout.stride ?? 0);
  if (inherited !== undefined) {
    state.declareContractUniform(inherited);
  }
  if (order.some((id) => view.getNode(id)?.readsSceneDepth === true)) {
    state.declareSceneDepth();
  }
  const outputVariables = new Map<string, string>();

  buildNodes(view, order, (node, id) => {
    node.build(
      new FXParticleKernelContextStandard(
        state,
        view,
        node,
        id,
        outputVariables,
        target,
        resolution.types,
      ),
    );
  });

  const outputBySlot = new Map<string, FXKernelTargetOutput>(
    target.outputs.map((output): [string, FXKernelTargetOutput] => [output.slot, output]),
  );
  const writes: FXPendingWrite[] = [];
  let kill: string | undefined;
  for (const binding of view.outputBindings) {
    const producerVariable = outputVariables.get(socketRefKey(binding.from));
    const isKill = binding.slot === target.killSlot;
    const output = outputBySlot.get(binding.slot);
    const slotType = isKill ? FLOAT : output?.type;
    const producerNode = view.getNode(binding.from.nodeId);
    if (producerVariable === undefined || producerNode === undefined || slotType === undefined) {
      continue;
    }
    const producerOutput = outputSocket(producerNode, binding.from.socketKey);
    const producerType =
      producerOutput === undefined
        ? undefined
        : socketConcreteType(binding.from.nodeId, producerOutput, resolution.types);
    const variable =
      producerType === undefined || producerType.id === slotType.id
        ? producerVariable
        : coerceOutputVariable(state, producerVariable, producerType, slotType);
    if (isKill) {
      kill = variable;
      continue;
    }
    if (output === undefined) {
      continue;
    }
    const buffer = output.buffer ?? BUILTIN_BUFFER;
    if (output.offsets.length === 1) {
      output.offsets.forEach((offset) => {
        writes.push({ buffer, offset, variable });
      });
    } else {
      output.offsets.forEach((offset, i) => {
        writes.push({ buffer, offset, variable, channel: SWIZZLE_CHANNELS[i] });
      });
    }
  }

  state.declareResources([
    ...writes.map((write) => write.variable),
    ...(kill === undefined ? [] : [kill]),
  ]);
  return {
    uniforms: state.declared,
    assemble: (otherUniforms) =>
      state.assemblePhase(target, writes, target.buffers, kill, otherUniforms),
  };
}

/** Adapts a producer variable to an output slot's declared type (pad/truncate/splat), emitting a
 *  converting local - mirrors the render backend's `coerceSlotOutput`. */
function coerceOutputVariable(
  state: FXKernelStateStandard,
  variable: string,
  fromType: FXValueType,
  toType: FXValueType,
): string {
  const name = state.uniqueName();
  state.emitLocal(name, coerceNumeric(ref("local", variable, fromType), toType));
  return name;
}

/**
 * Compiles both phases for the standard tier. Throws for a graph that is not GPU-compilable (for
 * example a JS-only call), so the caller can omit the GPU artifact.
 */
export function compileBehaviorStandard(
  graph: FXGraph<FXBehaviorNode>,
  targets: FXBehaviorTargets,
): FXCompiledKernelStandard {
  const validation: FXValidationResult = validateBehavior(graph, targets);
  throwIfInvalid(validation);

  const { order, resolution } = prepareCompile(graph);
  const phases = resolvePlacementPhases(graph, targets, order);
  const phaseOf = (id: string): FXBehaviorPhase =>
    phases.get(id) ?? graph.getNode(id)?.phase ?? FXBehaviorPhase.UPDATE;

  // One fused program holds both phases: both draw their names from one source, and each
  // phase's draw uniforms fit beside every uniform of the other - spawn's beside update's
  // bindings, update's beside all of spawn's.
  const names = new FXGLSLNames();
  const builtSpawn =
    targets.spawn !== undefined
      ? buildPhaseStandard(
          buildPhaseView(graph, FXBehaviorPhase.SPAWN, phaseOf),
          targets.spawn,
          names,
        )
      : undefined;
  const builtUpdate = buildPhaseStandard(
    buildPhaseView(graph, FXBehaviorPhase.UPDATE, phaseOf),
    targets.update,
    names,
  );
  const spawn = builtSpawn?.assemble(builtUpdate.uniforms);
  const update = builtUpdate.assemble(spawn?.uniforms ?? []);

  const hash = structuralHash(
    graph,
    `standard:${behaviorTargetsSignature(targets)}`,
    order,
    behaviorNodeKey(resolution.types, phases),
  );

  return { ...(spawn !== undefined ? { spawn } : {}), update, hash };
}

/** Resolves a `ref` to its GLSL access string for {@link printGLSLStandard}. */
export function resolveKernelRefStandard(
  target: FXKernelTarget,
  candidate: Extract<FXExpr, { kind: "ref" }>,
): string {
  switch (candidate.ref) {
    // A draw uniform is the draw stage's, computed once per pass.
    case "local":
    case "binding":
    case "uniform":
      return candidate.name;
    case "targetInput":
      return resolveTargetInputStandard(target, candidate.name);
    case "attribute":
      throw new Error(
        `resolveKernelRefStandard: ref kind "${candidate.ref}" is not valid in the behavior backend`,
      );
  }
}

function resolveTargetInputStandard(target: FXKernelTarget, name: string): string {
  const input = target.inputs.find((candidate) => candidate.name === name);
  if (input === undefined) {
    throw new Error(
      `resolveTargetInputStandard: target "${target.name}" declares no input "${name}"`,
    );
  }
  if (input.atBirth === true) {
    return BIRTH_MODEL_MATRIX_LOCAL;
  }
  if (input.inheritOffset !== undefined) {
    return inheritedUniformRead(input.inheritOffset, input.type.components);
  }
  switch (input.host?.kind) {
    case "parameter":
      return HOST_PARAMETER_UNIFORMS[input.host.parameter];
    case "particleIndex":
      return "gl_VertexID";
    case "emitter":
      return EMITTER_FIELD_UNIFORMS[input.host.field];
    case undefined:
      break;
  }
  if (input.offsets === undefined) {
    throw new Error(`resolveTargetInputStandard: input "${name}" has no state offset`);
  }
  const bufferName = input.buffer ?? BUILTIN_BUFFER;
  const attributeName =
    target.birth === true ? glslNewbornSlotName(bufferName) : glslBufferAttributeName(bufferName);
  if (input.offsets.length > 1) {
    // A whole-vector read; offsets exactly cover the buffer's stride.
    return attributeName;
  }
  const bufferStride = target.buffers.find((buffer) => buffer.name === bufferName)?.stride ?? 1;
  if (bufferStride === 1) {
    return attributeName;
  }
  const offset = input.offsets[0];
  if (offset === undefined) {
    throw new Error(
      `resolveTargetInputStandard: input "${name}" has no offset for a single-component read`,
    );
  }
  return `${attributeName}.${SWIZZLE_CHANNELS[offset]}`;
}
