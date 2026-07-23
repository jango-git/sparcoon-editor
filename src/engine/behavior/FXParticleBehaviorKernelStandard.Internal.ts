import {
  FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
  FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
} from "sparcoon";
import type { FXValidationResult } from "../core/compiler/FXCompilerError";
import { FXCompileContextBase } from "../core/compiler/FXCompileContextBase";
import {
  buildNodes,
  prepareCompile,
  throwIfInvalid,
} from "../core/compiler/compileDriver.Internal";
import { outputSocket } from "../core/compiler/FXSocketIndex.Internal";
import { socketConcreteType } from "../core/compiler/FXTypeResolve.Internal";
import { structuralHash } from "../core/compiler/FXStructuralHash.Internal";
import type { FXKernelContext } from "./FXKernelContext";
import type { FXValueParam } from "../core/compiler/FXCompilerContext";
import type { FXGraph } from "../core/FXGraph";
import { socketRefKey } from "../core/socket/FXSocket";
import type { FXExpr } from "../core/ir/FXExpr";
import { coerceNumeric, construct, createBuilders, ref } from "../core/ir/FXExprBuilder";
import type { FXExprBuilderApi } from "../core/ir/FXExprBuilder";
import { FX_FUNCTIONS, signaturesFrom } from "../core/ir/FXFunctions.Internal";
import type { FXValueType } from "../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../core/socket/FXValueType";
import { printGLSLStandard } from "../core/codegen/printGLSLStandard.Internal";
import { uniqueIdentifier } from "../core/codegen/uniqueName.Internal";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import { FXBehaviorPhase } from "./FXBehaviorPhase";
import type {
  FXKernelBindingDescriptor,
  FXKernelBindingHandle,
  FXKernelBufferLayout,
  FXKernelWrite,
} from "./FXCompiledKernel";
import type {
  FXBehaviorTargets,
  FXKernelTarget,
  FXKernelTargetOutput,
} from "./FXParticleBehaviorTarget";
import { FX_EMITTER_INPUT_FIELD, FX_PARTICLE_INDEX_INPUT } from "./FXParticleBehaviorTarget";
import { BUILTIN_BUFFER } from "./FXKernelShared.Internal";
import {
  buildPhaseView,
  resolvePlacementPhases,
  validateBehavior,
} from "./FXKernelValidation.Internal";
import { behaviorNodeKey } from "./FXKernelStructuralHash.Internal";
import { behaviorTargetsSignature } from "./FXKernelTargetSignature.Internal";

/**
 * The standard-tier (WebGL2 / GLSL-ES-3.00, transform-feedback) behavior compiler: an independent
 * sibling of `FXParticleBehaviorKernel.Internal.ts`, not a shared-with-JS abstraction below the IR
 * - the same independence the render backend's own standard pipeline already established
 * (`FXCompilePipelineStandard.Internal.ts`'s doc comment). Unlike the JS backend, this one does
 * NOT scalarize or run a separate CSE/loop-invariant pass: GLSL handles vectors natively, and
 * anything invariant across the whole draw (dt, the emitter transform, bindings) is already a
 * uniform - evaluated once by the driver, not per-invocation - so there is no host-side loop to
 * hoist out of. This mirrors the render-standard pipeline's shape (print each node's output
 * inline as its `build()` runs), not the JS behavior pipeline's.
 *
 * Produces one {@link FXCompiledPhaseStandard} per phase (spawn/update compiled independently, as
 * on the JS side); fusing the two into one transform-feedback program with a birth-branch is the
 * assembler's job (`FXKernelBuildStandard.Internal.ts`), not this file's.
 */

/** GLSL-safe swizzle channel for offset `0..3`. */
const SWIZZLE_CHANNELS = ["x", "y", "z", "w"] as const;

const FLOAT = FX_VALUE_TYPES.float;

/** Component suffixes for a vector value param's per-component binding hints (`positionx`, ...). */
const VEC_COMPONENT_NAMES = ["x", "y", "z", "w"] as const;

/** This backend's bound builders: the core registry only, deliberately excluding
 *  `FX_BEHAVIOR_FUNCTIONS` (documented JS-only, e.g. `sampleLut`) - a node calling one throws a
 *  clean, catchable "unknown function" at build time instead of emitting GLSL that references an
 *  undefined function, which would only fail later when the browser links the shader. */
const STANDARD_BEHAVIOR_BUILDERS: FXExprBuilderApi = createBuilders(signaturesFrom(FX_FUNCTIONS));

/** Deterministic GLSL `in`-attribute name for a state buffer (matches the buffer's own layout -
 *  one vector attribute per buffer, never one scalar attribute per component). Exported so the
 *  assembler (`FXKernelBuildStandard.Internal.ts`) prints the same name in the declaration this
 *  resolver prints in the body - the runtime itself never needs to know it, since it binds by the
 *  buffer's `layout(location = N)` index, not by attribute name. */
export function glslBufferAttributeName(bufferName: string): string {
  return `in_${bufferName}`;
}

/** `dt`/emitter-transform-field name -> the fixed, shared uniform name from sparcoon's
 *  `behaviorTransformFeedbackLayout.ts` - both sides import the same literal constants, never
 *  independently derive them (unlike {@link glslBufferAttributeName}, which only the editor's own
 *  two files need to agree on). */
const SYNTHESIZED_UNIFORM_NAMES: Readonly<
  Record<"dt" | "worldMatrix" | "velocity" | "angularVelocity", string>
> = {
  dt: FX_TRANSFORM_FEEDBACK_DELTA_TIME_UNIFORM,
  worldMatrix: FX_TRANSFORM_FEEDBACK_MODEL_MATRIX_UNIFORM,
  velocity: FX_TRANSFORM_FEEDBACK_OBJECT_VELOCITY_UNIFORM,
  angularVelocity: FX_TRANSFORM_FEEDBACK_OBJECT_ANGULAR_VELOCITY_UNIFORM,
};

/** One compiled phase's GLSL fragment - the assembler's fusion input. Deliberately not
 *  `FXCompiledKernelPhase` (that shape assumes JS's untyped, string-keyed bindings-as-closures;
 *  GLSL needs each binding's declared type to print a `uniform` statement, so uniform
 *  declarations are tracked as real text here, not derived later from a value's runtime shape). */
export interface FXCompiledPhaseStandard {
  readonly helpers: readonly string[];
  readonly uniformDeclarations: readonly string[];
  readonly body: readonly string[];
  readonly writes: readonly FXKernelWrite[];
  readonly bindings: Readonly<Record<string, FXKernelBindingHandle>>;
  readonly buffers: readonly FXKernelBufferLayout[];
  readonly writtenBuffers: readonly string[];
}

export interface FXCompiledKernelStandard {
  readonly spawn?: FXCompiledPhaseStandard;
  readonly update: FXCompiledPhaseStandard;
  readonly hash: string;
}

/** Mutable accumulator for one phase's compilation - the standard-tier analog of `FXKernelState`,
 *  shaped like render's `FXCompileState` instead (no CSE/invariant-partition, see the module doc). */
class FXKernelStateStandard {
  private counter = 0;
  private readonly bodyLines: string[] = [];
  private readonly helperMap = new Map<string, string>();
  private readonly uniformDeclarations: string[] = [];
  private readonly bindingHandles: FXKernelBindingHandle[] = [];
  private readonly namedBindingTypes = new Map<string, string>();

  public uniqueName(hint: string): string {
    const name = uniqueIdentifier(hint, "_", this.counter);
    this.counter += 1;
    return name;
  }

  public emit(statement: string): void {
    this.bodyLines.push(statement);
  }

  public emitHelper(key: string, source: string): void {
    if (!this.helperMap.has(key)) {
      this.helperMap.set(key, source);
    }
  }

  /** Declares a live-tunable uniform, deduped by a forced name (a param slot) the same way the
   *  JS backend dedupes bindings; two allocations of the same name share one uniform. */
  public allocateBinding(
    descriptor: FXKernelBindingDescriptor,
    glslTypeName: string,
  ): FXKernelBindingHandle {
    if (descriptor.name !== undefined) {
      const existing = this.bindingHandles.find((handle) => handle.name === descriptor.name);
      if (existing !== undefined) {
        const priorType = this.namedBindingTypes.get(descriptor.name);
        if (priorType !== undefined && priorType !== glslTypeName) {
          throw new Error(
            `FXKernelStateStandard.allocateBinding: uniform "${descriptor.name}" is declared as ` +
              `both ${priorType} and ${glslTypeName}`,
          );
        }
        return existing;
      }
      this.declareUniform(descriptor.name, glslTypeName);
      const handle: FXKernelBindingHandle = { name: descriptor.name, value: descriptor.value };
      this.bindingHandles.push(handle);
      this.namedBindingTypes.set(descriptor.name, glslTypeName);
      return handle;
    }
    const name = this.uniqueName(`u_${descriptor.hint ?? "binding"}`);
    this.declareUniform(name, glslTypeName);
    const handle: FXKernelBindingHandle = { name, value: descriptor.value };
    this.bindingHandles.push(handle);
    return handle;
  }

  public assemblePhase(
    writes: readonly FXKernelWrite[],
    buffers: readonly FXKernelBufferLayout[],
  ): FXCompiledPhaseStandard {
    const bindings: Record<string, FXKernelBindingHandle> = {};
    for (const handle of this.bindingHandles) {
      bindings[handle.name] = handle;
    }
    const written = new Set(writes.map((write) => write.buffer));
    return {
      helpers: [...this.helperMap.values()],
      uniformDeclarations: this.uniformDeclarations,
      body: this.bodyLines,
      writes,
      bindings,
      buffers,
      writtenBuffers: [...written],
    };
  }

  private declareUniform(name: string, glslTypeName: string): void {
    this.uniformDeclarations.push(`uniform ${glslTypeName} ${name};`);
  }
}

/** {@link FXKernelContext} bound to one node; emits native-vector GLSL over `in`-attribute state
 *  (no scalarization - see the module doc). */
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
    const { code, helpers } = printGLSLStandard(expression, FX_FUNCTIONS, (candidate) =>
      resolveKernelRefStandard(this.target, candidate),
    );
    for (const [key, source] of helpers) {
      this.state.emitHelper(key, source);
    }
    const name = this.state.uniqueName(this.outputHint(socketKey));
    this.state.emit(`${expression.type.glslTypeName} ${name} = ${code};`);
    this.outputVariables.set(socketRefKey({ nodeId: this.nodeId, socketKey }), name);
  }

  public defineLocal(hint: string, expression: FXExpr): FXExpr {
    const { code, helpers } = printGLSLStandard(expression, FX_FUNCTIONS, (candidate) =>
      resolveKernelRefStandard(this.target, candidate),
    );
    for (const [key, source] of helpers) {
      this.state.emitHelper(key, source);
    }
    const name = this.state.uniqueName(hint);
    this.state.emit(`${expression.type.glslTypeName} ${name} = ${code};`);
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

  public uniqueName(hint: string): string {
    return this.state.uniqueName(hint);
  }

  public emitHelper(key: string, source: string): void {
    this.state.emitHelper(key, source);
  }

  // `FXKernelBindingHandle.value: number | Float32Array` is shared with the JS backend, where
  // `Float32Array` exclusively means "a LUT, sample through sampleLut" - never repurposed here
  // for "a live vector uniform's value" (that would make the two meanings ambiguous to every
  // future reader/consumer of `bindings`). A vector value param is instead one binding per
  // component (each a plain number, `uniform float`), exactly like the JS backend's own
  // `allocateValueParam` - simpler and unambiguous, at the cost of one `gl.uniform1f` call per
  // component at runtime instead of a single `gl.uniform3fv`.
  public allocateBinding(descriptor: FXKernelBindingDescriptor): FXKernelBindingHandle {
    const glslTypeName = descriptor.value instanceof Float32Array ? "sampler2D" : "float";
    return this.state.allocateBinding(descriptor, glslTypeName);
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

/** Compiles one already-isolated phase view into its {@link FXCompiledPhaseStandard}. */
function compilePhaseStandard(
  view: FXGraph<FXBehaviorNode>,
  target: FXKernelTarget,
): FXCompiledPhaseStandard {
  const { order, resolution } = prepareCompile(view);
  const state = new FXKernelStateStandard();
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
  const writes: FXKernelWrite[] = [];
  for (const binding of view.outputBindings) {
    const producerVariable = outputVariables.get(socketRefKey(binding.from));
    const output = outputBySlot.get(binding.slot);
    const producerNode = view.getNode(binding.from.nodeId);
    if (producerVariable === undefined || output === undefined || producerNode === undefined) {
      continue;
    }
    const producerOutput = outputSocket(producerNode, binding.from.socketKey);
    const producerType =
      producerOutput === undefined
        ? undefined
        : socketConcreteType(binding.from.nodeId, producerOutput, resolution.types);
    const buffer = output.buffer ?? BUILTIN_BUFFER;
    const variable =
      producerType === undefined || producerType.id === output.type.id
        ? producerVariable
        : coerceOutputVariable(state, producerVariable, producerType, output.type);
    if (output.offsets.length === 1) {
      output.offsets.forEach((offset) => {
        writes.push({ buffer, offset, expr: variable });
      });
    } else {
      output.offsets.forEach((offset, i) => {
        writes.push({
          buffer,
          offset,
          expr: `${variable}.${SWIZZLE_CHANNELS[i]}`,
        });
      });
    }
  }

  return state.assemblePhase(writes, target.buffers);
}

/** Adapts a producer variable to an output slot's declared type (pad/truncate/splat), emitting a
 *  converting local - mirrors the render backend's `coerceSlotOutput`. */
function coerceOutputVariable(
  state: FXKernelStateStandard,
  variable: string,
  fromType: FXValueType,
  toType: FXValueType,
): string {
  const { code, helpers } = printGLSLStandard(
    coerceNumeric(ref("local", variable, fromType), toType),
    FX_FUNCTIONS,
  );
  for (const [key, source] of helpers) {
    state.emitHelper(key, source);
  }
  const name = state.uniqueName(`slot_${toType.glslTypeName}`);
  state.emit(`${toType.glslTypeName} ${name} = ${code};`);
  return name;
}

/** Compiles a two-phase behavior graph for the standard tier. Throws (never a broken artifact) on
 *  a graph that is not GPU-compilable - an unknown-function throw from a JS-only call (e.g.
 *  `sampleLut`) surfaces exactly like any other build error, so the caller (a "Try GPU
 *  simulation"-gated compile attempt) can catch it and silently omit the GPU artifact for that
 *  emitter. */
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

  const spawn =
    targets.spawn !== undefined
      ? compilePhaseStandard(buildPhaseView(graph, FXBehaviorPhase.SPAWN, phaseOf), targets.spawn)
      : undefined;
  const update = compilePhaseStandard(
    buildPhaseView(graph, FXBehaviorPhase.UPDATE, phaseOf),
    targets.update,
  );

  const hash = structuralHash(
    graph,
    `standard:${behaviorTargetsSignature(targets)}`,
    order,
    behaviorNodeKey(resolution.types, phases),
  );

  return { ...(spawn !== undefined ? { spawn } : {}), update, hash };
}

/** Resolves a `ref` to its GLSL access string for {@link printGLSLStandard} - the standard-tier
 *  analog of `resolveKernelRef`. */
export function resolveKernelRefStandard(
  target: FXKernelTarget,
  candidate: Extract<FXExpr, { kind: "ref" }>,
): string {
  switch (candidate.ref) {
    case "local":
    case "binding":
      return candidate.name;
    case "targetInput":
      return resolveTargetInputStandard(target, candidate.name);
    case "uniform":
    case "attribute":
      throw new Error(
        `resolveKernelRefStandard: ref kind "${candidate.ref}" is not valid in the behavior backend`,
      );
  }
}

function resolveTargetInputStandard(target: FXKernelTarget, name: string): string {
  if (name === "dt") {
    return SYNTHESIZED_UNIFORM_NAMES["dt"];
  }
  if (name === FX_PARTICLE_INDEX_INPUT) {
    return "gl_VertexID";
  }
  const input = target.inputs.find((candidate) => candidate.name === name);
  if (input === undefined) {
    throw new Error(
      `resolveTargetInputStandard: target "${target.name}" declares no input "${name}"`,
    );
  }
  if (input.offsets === undefined) {
    const field = FX_EMITTER_INPUT_FIELD[name];
    const uniformName = field === undefined ? undefined : SYNTHESIZED_UNIFORM_NAMES[field];
    if (uniformName === undefined) {
      throw new Error(`resolveTargetInputStandard: input "${name}" has no state offset`);
    }
    return uniformName;
  }
  const bufferName = input.buffer ?? BUILTIN_BUFFER;
  const attributeName = glslBufferAttributeName(bufferName);
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
