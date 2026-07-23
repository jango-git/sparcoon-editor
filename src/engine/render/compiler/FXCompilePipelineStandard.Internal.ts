import type { FXCompilerError } from "../../core/compiler/FXCompilerError";
import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import {
  collectReachableNodeIds,
  topologicalOrder,
} from "../../core/compiler/FXGraphTraversal.Internal";
import { resolvePlacement } from "../../core/compiler/placement.Internal";
import { genericTypeTag, socketConcreteType } from "../../core/compiler/FXTypeResolve.Internal";
import { buildNodes, prepareCompile } from "../../core/compiler/compileDriver.Internal";
import { FXCompileContextBase } from "../../core/compiler/FXCompileContextBase";
import { outputSocket } from "../../core/compiler/FXSocketIndex.Internal";
import { structuralHash } from "../../core/compiler/FXStructuralHash.Internal";
import type { FXValueParam } from "../../core/compiler/FXCompilerContext";
import type { FXGraph } from "../../core/FXGraph";
import type { FXValueType } from "../../core/socket/FXValueType";
import type { FXExpr } from "../../core/ir/FXExpr";
import { coerceNumeric, createBuilders, ref } from "../../core/ir/FXExprBuilder";
import type { FXExprBuilderApi } from "../../core/ir/FXExprBuilder";
import { FX_FUNCTIONS, signaturesFrom } from "../../core/ir/FXFunctions.Internal";
import { printGLSLStandard } from "../../core/codegen/printGLSLStandard.Internal";
import { uniqueIdentifier } from "../../core/codegen/uniqueName.Internal";
import type { FXSocketRef } from "../../core/socket/FXSocket";
import { socketRefKey } from "../../core/socket/FXSocket";
import type { FXRenderNode } from "../FXRenderNode";
import { FXShaderStage } from "../FXShaderStage";
import type { FXTarget, FXTargetOutput } from "../target/FXTarget";
import { renderTargetSignature } from "../target/FXTargetSignature.Internal";
import type {
  FXCompiledShader,
  FXUniformDescriptor,
  FXUniformHandle,
  FXVarying,
} from "./FXCompiledShader";
import type { FXRenderContext } from "./FXRenderContext";

/**
 * The standard (WebGL2 / GLSL-ES-3.00) render compiler pipeline: deliberately independent of the
 * baseline tier's `FXCompilePipelineBaseline.Internal.ts` all the way down to the
 * compile-state/context/placement layer, not just the printer or the build-method selection. Per
 * the project's tier-axis decision, the baseline and standard tiers share nothing below the IR
 * (`core/ir/`) and the shading-language-neutral compilation core
 * (`core/compiler/`) - the same degree of separation the future advanced (WebGPU/WGSL) tier would
 * have from either. Duplication with `FXCompilePipelineBaseline.Internal.ts` is intentional: this
 * tier's declaration strategy, placement rules, and optimizations are free to diverge without ever
 * touching that file.
 */

/** This tier's bound builders - the full, unfiltered signature set (including `standardOnly`
 *  functions). */
const STANDARD_BUILDERS: FXExprBuilderApi = createBuilders(signaturesFrom(FX_FUNCTIONS));

/** Whether a value produced in `producer` can reach a consumer in `consumer`: same-stage is
 *  always fine, and vertex->fragment promotes through a varying, but not the reverse. */
function isReachableStage(producer: FXShaderStage, consumer: FXShaderStage): boolean {
  return (
    producer === consumer ||
    (producer === FXShaderStage.VERTEX && consumer === FXShaderStage.FRAGMENT)
  );
}

/** Infers the effective stage of every reachable node. Fixed-stage nodes keep their declared
 *  stage; a placement-flexible node (e.g. `constant`) is placed `vertex` if any consumer or bound
 *  output slot needs it there (vertex promotes to fragment, so that's the safe choice), else
 *  `fragment`. */
export function resolvePlacementStages(
  graph: FXGraph<FXRenderNode>,
  target: FXTarget,
  order: readonly string[],
): Map<string, FXShaderStage> {
  const slotStage = new Map<string, FXShaderStage>(
    target.outputs.map((output) => [output.slot, output.stage]),
  );
  return resolvePlacement<FXRenderNode, FXShaderStage>(graph, order, {
    isFlexible: (node) => node.stageFlexible,
    fixedSlot: (node) => node.stage,
    resolveFlexible: (_node, consumerSlots, bindings) => {
      const needsVertex =
        consumerSlots.some((stage) => stage === FXShaderStage.VERTEX) ||
        bindings.some((binding) => slotStage.get(binding.slot) === FXShaderStage.VERTEX);
      return needsVertex ? FXShaderStage.VERTEX : FXShaderStage.FRAGMENT;
    },
  });
}

/** Structural-hash tag for a node's inferred placement; only flexible nodes contribute (a fixed
 *  node's stage is implied by its already-hashed `type`), so a rewiring that moves one between
 *  stages recompiles rather than rebinds. */
function stageTag(
  stages: ReadonlyMap<string, FXShaderStage>,
  id: string,
  node: FXRenderNode,
): string {
  return node.stageFlexible ? `@${stages.get(id) ?? ""}` : "";
}

/** The per-node structural-hash key for this backend: resolved generic type tag plus the
 *  inferred-stage tag, folded into `structuralHash` by both `compileGraphStandard` and
 *  `FXCompilerStandard.previewHash`. */
export function renderNodeKey(
  types: ReadonlyMap<string, FXValueType>,
  stages: ReadonlyMap<string, FXShaderStage>,
): (id: string, node: FXRenderNode) => string {
  return (id, node) => genericTypeTag(types, id) + stageTag(stages, id, node);
}

/** Validates that every reachable value flows in a compilable stage direction, using each node's
 *  effective (inferred) stage - the half `validateGraph` leaves open. Kept out of the
 *  backend-agnostic core validator since vertex->fragment promotion is GLSL-specific. */
export function validateStageDirection(
  graph: FXGraph<FXRenderNode>,
  target: FXTarget,
): FXCompilerError[] {
  const errors: FXCompilerError[] = [];
  const reachable = collectReachableNodeIds(graph);
  const { order } = topologicalOrder(graph, reachable);
  const stages = resolvePlacementStages(graph, target, order);
  const stageOf = (id: string): FXShaderStage | undefined =>
    stages.get(id) ?? graph.getNode(id)?.stage;

  // A custom node can carry a stage outside the enum past the type system; gate
  // membership first so a junk stage surfaces as a typed error, not a later crash.
  const legalStages: readonly FXShaderStage[] = [FXShaderStage.VERTEX, FXShaderStage.FRAGMENT];
  for (const id of reachable) {
    const stage = stageOf(id);
    if (graph.getNode(id) !== undefined && !legalStages.some((legal) => legal === stage)) {
      errors.push({
        code: "unknown-render-stage",
        message: `node "${id}" declares unknown stage "${String(stage)}"; render nodes must be "${FXShaderStage.VERTEX}" or "${FXShaderStage.FRAGMENT}"`,
        nodeId: id,
        params: { nodeId: id, stage: String(stage) },
      });
    }
  }

  for (const connection of graph.connections) {
    if (!reachable.has(connection.to.nodeId)) {
      continue;
    }
    const producerStage = stageOf(connection.from.nodeId);
    const consumerStage = stageOf(connection.to.nodeId);
    if (producerStage === undefined || consumerStage === undefined) {
      continue;
    }
    if (!isReachableStage(producerStage, consumerStage)) {
      errors.push({
        code: "stage-input-mismatch",
        message: `input "${connection.to.socketKey}" of ${consumerStage} node "${connection.to.nodeId}" reads a ${producerStage}-stage value from node "${connection.from.nodeId}"; a ${producerStage} value cannot flow into the ${consumerStage} stage`,
        nodeId: connection.to.nodeId,
        socketKey: connection.to.socketKey,
        params: {
          socketKey: connection.to.socketKey,
          consumerStage,
          consumerNodeId: connection.to.nodeId,
          producerStage,
          producerNodeId: connection.from.nodeId,
        },
      });
    }
  }

  const outputStages = new Map<string, FXShaderStage>(
    target.outputs.map((output): [string, FXShaderStage] => [output.slot, output.stage]),
  );
  for (const binding of graph.outputBindings) {
    const producerStage = stageOf(binding.from.nodeId);
    const slotStage = outputStages.get(binding.slot);
    if (producerStage === undefined || slotStage === undefined) {
      continue;
    }
    if (!isReachableStage(producerStage, slotStage)) {
      errors.push({
        code: "stage-output-mismatch",
        message: `output slot "${binding.slot}" is filled in the ${slotStage} stage but node "${binding.from.nodeId}" produces its value in the ${producerStage} stage`,
        nodeId: binding.from.nodeId,
        slot: binding.slot,
        params: { slot: binding.slot, slotStage, nodeId: binding.from.nodeId, producerStage },
      });
    }
  }

  return errors;
}

/** Mutable accumulator for one compilation (identifiers, uniforms, varyings, helpers, per-stage
 *  bodies). Nodes never see this directly - only through {@link FXNodeCompilerContext}. */
class FXCompileState {
  private counter = 0;

  private readonly uniformsByName = new Map<string, FXUniformHandle>();
  /** Declared GLSL type per forced (param) uniform name, to catch a same-name type clash. */
  private readonly namedUniformTypes = new Map<string, string>();
  private readonly uniformDeclarations: string[] = [];
  private readonly varyingList: FXVarying[] = [];
  private readonly vertexBody: string[] = [];
  private readonly fragmentBody: string[] = [];
  private readonly vertexHelpers = new Map<string, string>();
  private readonly fragmentHelpers = new Map<string, string>();
  /** Promotion cache: producer socket key -> the varying carrying it. */
  private readonly varyingCache = new Map<string, string>();

  /** Allocates a collision-free, GLSL-safe identifier from a hint. */
  public uniqueName(hint: string): string {
    const name = uniqueIdentifier(hint, "_", this.counter);
    this.counter += 1;
    return name;
  }

  public emit(stage: FXShaderStage, statement: string): void {
    this.bodyFor(stage).push(statement);
  }

  /** Adds a helper function to a stage, deduplicated by `key`. */
  public emitHelper(stage: FXShaderStage, key: string, source: string): void {
    const helpers = this.helpersFor(stage);
    if (!helpers.has(key)) {
      helpers.set(key, source);
    }
  }

  public allocateUniform(descriptor: FXUniformDescriptor): FXUniformHandle {
    // A forced name (a param slot) is used verbatim and deduped, so two param nodes of the
    // same name share one uniform (and a name survives structural edits - timeline-addressable);
    // a type clash between them is a compile error. Otherwise auto-number from the hint.
    if (descriptor.name !== undefined) {
      const glslType = descriptor.type.glslTypeName;
      const existing = this.uniformsByName.get(descriptor.name);
      if (existing !== undefined) {
        const priorType = this.namedUniformTypes.get(descriptor.name);
        if (priorType !== undefined && priorType !== glslType) {
          throw new FXCompilerErrorException({
            code: "param-uniform-type-conflict",
            message: `param uniform "${descriptor.name}" is declared as both ${priorType} and ${glslType}`,
            params: { name: descriptor.name, priorType, newType: glslType },
          });
        }
        return existing;
      }
      this.uniformDeclarations.push(`uniform ${glslType} ${descriptor.name};`);
      this.namedUniformTypes.set(descriptor.name, glslType);
      const handle: FXUniformHandle =
        descriptor.external === true
          ? { name: descriptor.name, value: descriptor.value, external: descriptor.name }
          : { name: descriptor.name, value: descriptor.value };
      this.uniformsByName.set(descriptor.name, handle);
      return handle;
    }
    const name = this.uniqueName(`u_${descriptor.hint ?? "uniform"}`);
    this.uniformDeclarations.push(`uniform ${descriptor.type.glslTypeName} ${name};`);
    const handle: FXUniformHandle = { name, value: descriptor.value };
    this.uniformsByName.set(name, handle);
    return handle;
  }

  /** Declares a vertex->fragment varying and returns its name. */
  public allocateVarying(type: FXValueType, hint: string): string {
    const name = this.uniqueName(`v_${hint}`);
    this.varyingList.push({ name, type });
    return name;
  }

  /** Routes a value across stages through a varying, reusing one already allocated for the same
   *  producer. Only vertex->fragment is meaningful; same-stage returns the variable unchanged. */
  public promote(
    producerKey: string,
    producerVariable: string,
    type: FXValueType,
    producerStage: FXShaderStage,
    consumerStage: FXShaderStage,
  ): string {
    if (producerStage === consumerStage) {
      return producerVariable;
    }
    const cached = this.varyingCache.get(producerKey);
    if (cached !== undefined) {
      return cached;
    }
    if (!type.instantiable) {
      // A non-instantiable (opaque) type - a `sampler2D` - cannot ride a varying:
      // `varying sampler2D v_bridge;` is illegal GLSL. Type validation and
      // `validateStageDirection` (direction only) both pass such an edge, so reject
      // it here with a typed error the live layer folds into `invalid`.
      throw new FXCompilerErrorException({
        code: "opaque-type-crosses-stage",
        message: `opaque type ${type.id} cannot cross shader stages through a varying`,
        nodeId: producerKey.slice(0, producerKey.lastIndexOf(" ")),
        params: { typeId: type.id },
      });
    }
    const name = this.allocateVarying(type, "bridge");
    this.emit(producerStage, `${name} = ${producerVariable};`);
    this.varyingCache.set(producerKey, name);
    return name;
  }

  public assemble(outputs: Record<string, string>, hash: string): FXCompiledShader {
    const varyingDeclarations = this.varyingList.map(
      (varying) => `varying ${varying.type.glslTypeName} ${varying.name};`,
    );

    const uniforms: Record<string, FXUniformHandle> = {};
    for (const [name, handle] of this.uniformsByName) {
      uniforms[name] = handle;
    }

    return {
      uniforms,
      uniformDeclarations: this.uniformDeclarations,
      vertex: {
        varyingDeclarations,
        helperFunctions: [...this.vertexHelpers.values()],
        body: this.vertexBody,
      },
      fragment: {
        varyingDeclarations,
        helperFunctions: [...this.fragmentHelpers.values()],
        body: this.fragmentBody,
      },
      outputs,
      hash,
    };
  }

  private bodyFor(stage: FXShaderStage): string[] {
    switch (stage) {
      case FXShaderStage.VERTEX:
        return this.vertexBody;
      case FXShaderStage.FRAGMENT:
        return this.fragmentBody;
    }
  }

  private helpersFor(stage: FXShaderStage): Map<string, string> {
    switch (stage) {
      case FXShaderStage.VERTEX:
        return this.vertexHelpers;
      case FXShaderStage.FRAGMENT:
        return this.fragmentHelpers;
    }
  }
}

/** {@link FXRenderContext} bound to one node for the duration of its `build`; forwards emissions
 *  to the shared {@link FXCompileState}. This backend's builders and GLSL printer are hardcoded
 *  module constants, never injected. This backend has no concept of `baselineBuild` - it always runs
 *  a node's primary `build`. */
class FXNodeCompilerContext
  extends FXCompileContextBase<FXRenderNode, string>
  implements FXRenderContext
{
  protected readonly contextLabel = "FXCompilerContext";

  constructor(
    private readonly state: FXCompileState,
    graph: FXGraph<FXRenderNode>,
    private readonly target: FXTarget,
    node: FXRenderNode,
    nodeId: string,
    outputVariables: Map<string, string>,
    types: ReadonlyMap<string, FXValueType>,
    private readonly stageOf: (id: string) => FXShaderStage,
  ) {
    super(graph, node, nodeId, outputVariables, types);
  }

  public get builders(): FXExprBuilderApi {
    return STANDARD_BUILDERS;
  }

  public get stage(): FXShaderStage {
    return this.stageOf(this.nodeId);
  }

  public setOutput(socketKey: string, expression: FXExpr): void {
    const socket = outputSocket(this.node, socketKey);
    if (socket === undefined) {
      throw new Error(
        `FXCompilerContext.setOutput: node "${this.nodeId}" has no output socket "${socketKey}"`,
      );
    }
    const socketType = socketConcreteType(this.nodeId, socket, this.types);
    if (socketType === undefined) {
      throw new Error(
        `FXCompilerContext.setOutput: output "${socketKey}" of node "${this.nodeId}" has an unresolved generic type`,
      );
    }

    const { code, helpers } = printGLSLStandard(expression, FX_FUNCTIONS);
    for (const [key, source] of helpers) {
      this.state.emitHelper(this.stage, key, source);
    }

    const key = socketRefKey({ nodeId: this.nodeId, socketKey });
    if (socketType.instantiable) {
      const name = this.state.uniqueName(this.outputHint(socketKey));
      this.state.emit(this.stage, `${socketType.glslTypeName} ${name} = ${code};`);
      this.outputVariables.set(key, name);
    } else {
      // Opaque types (e.g. samplers) cannot be locals; pass the reference through.
      this.outputVariables.set(key, code);
    }
  }

  public defineLocal(hint: string, expression: FXExpr): FXExpr {
    const { code, helpers } = printGLSLStandard(expression, FX_FUNCTIONS);
    for (const [key, source] of helpers) {
      this.state.emitHelper(this.stage, key, source);
    }
    const name = this.state.uniqueName(hint);
    this.state.emit(this.stage, `${expression.type.glslTypeName} ${name} = ${code};`);
    return ref("local", name, expression.type);
  }

  public readTargetInput(name: string): FXExpr {
    // Typed throws so a live apply repackages a third-party node's bad target read
    // with its code/nodeId intact, instead of a bare Error folded to compile-failed.
    const input = this.target.inputs.find((candidate) => candidate.name === name);
    if (input === undefined) {
      throw new FXCompilerErrorException({
        code: "unknown-target-input",
        message: `FXCompilerContext.readTargetInput: target "${this.target.name}" provides no input "${name}"`,
        nodeId: this.nodeId,
      });
    }
    if (!input.stages.includes(this.stage)) {
      throw new FXCompilerErrorException({
        code: "target-input-stage-mismatch",
        message: `FXCompilerContext.readTargetInput: input "${name}" is not available in the ${this.stage} stage`,
        nodeId: this.nodeId,
        socketKey: name,
      });
    }
    return ref("targetInput", name, input.type);
  }

  public uniqueName(hint: string): string {
    return this.state.uniqueName(hint);
  }

  public allocateUniform(descriptor: FXUniformDescriptor): FXUniformHandle {
    return this.state.allocateUniform(descriptor);
  }

  /** A value param is one uniform (vecN native); edits publish by rewriting its value. */
  public allocateValueParam(
    type: FXValueType,
    value: number | readonly number[],
    hint: string,
  ): FXValueParam {
    const handle = this.allocateUniform({
      type,
      value: typeof value === "number" ? value : value.slice(),
      hint,
    });
    return {
      expr: ref("uniform", handle.name, type),
      handle: {
        update: (next): void => {
          handle.value = typeof next === "number" ? next : next.slice();
        },
      },
    };
  }

  public allocateVarying(type: FXValueType, hint: string): string {
    if (this.stage === FXShaderStage.FRAGMENT) {
      // A varying is written in vertex and read in fragment; allocating one from a fragment
      // node would emit an illegal fragment-body assignment.
      throw new FXCompilerErrorException({
        code: "varying-from-fragment-stage",
        message: `node "${this.nodeId}" allocated a varying from the fragment stage; varyings are produced in the vertex stage`,
        nodeId: this.nodeId,
        params: { nodeId: this.nodeId },
      });
    }
    return this.state.allocateVarying(type, hint);
  }

  public emitHelper(key: string, source: string): void {
    this.state.emitHelper(this.stage, key, source);
  }

  /** Brings a producer local into this node's stage (promoting vertex->fragment if needed). */
  protected override materializeProducer(
    producerVariable: string,
    producerType: FXValueType,
    from: FXSocketRef,
  ): FXExpr {
    const producerStage = this.stageOf(from.nodeId);
    const variable =
      producerStage === this.stage
        ? producerVariable
        : this.state.promote(
            socketRefKey(from),
            producerVariable,
            producerType,
            producerStage,
            this.stage,
          );
    return ref("local", variable, producerType);
  }
}

/** Adapts a producer variable to an output slot's declared type, emitting a converting local
 *  when the widths differ; returns the variable unchanged when types already match. */
function coerceSlotOutput(
  state: FXCompileState,
  stage: FXShaderStage,
  variable: string,
  fromType: FXValueType | undefined,
  toType: FXValueType,
): string {
  if (fromType === undefined || fromType.id === toType.id) {
    return variable;
  }
  const { code, helpers } = printGLSLStandard(
    coerceNumeric(ref("local", variable, fromType), toType),
    FX_FUNCTIONS,
  );
  for (const [key, source] of helpers) {
    state.emitHelper(stage, key, source);
  }
  const name = state.uniqueName(`slot_${toType.glslTypeName}`);
  state.emit(stage, `${toType.glslTypeName} ${name} = ${code};`);
  return name;
}

/**
 * Compiles a validated graph into an {@link FXCompiledShader} for the standard (WebGL2) tier.
 * Mirrors `FXCompilePipelineBaseline.Internal.ts`'s `compileGraphBaseline` in shape only - see the
 * module doc comment for why the implementation itself is a separate copy, not a shared helper.
 */
export function compileGraphStandard(
  graph: FXGraph<FXRenderNode>,
  target: FXTarget,
): FXCompiledShader {
  const { order, resolution } = prepareCompile(graph);
  const stages = resolvePlacementStages(graph, target, order);
  const stageOf = (id: string): FXShaderStage =>
    stages.get(id) ?? graph.getNode(id)?.stage ?? FXShaderStage.FRAGMENT;

  const state = new FXCompileState();
  const outputVariables = new Map<string, string>();

  buildNodes(graph, order, (node, id) => {
    const context = new FXNodeCompilerContext(
      state,
      graph,
      target,
      node,
      id,
      outputVariables,
      resolution.types,
      stageOf,
    );
    node.build(context);
  });

  const targetOutputs = new Map<string, FXTargetOutput>(
    target.outputs.map((output): [string, FXTargetOutput] => [output.slot, output]),
  );
  const outputs: Record<string, string> = {};

  for (const binding of graph.outputBindings) {
    const slotDefinition = targetOutputs.get(binding.slot);
    const producer = graph.getNode(binding.from.nodeId);
    // An unknown slot or a dangling producer is a graph-shape error `validateGraph`
    // catches; if one slips through, skip it rather than emit a bad slot.
    if (slotDefinition === undefined || producer === undefined) {
      continue;
    }

    const producerVariable = outputVariables.get(socketRefKey(binding.from));
    if (producerVariable === undefined) {
      // The producer node ran but never emitted a value for this output socket (a third-party
      // node that declares an output its `build()` does not fill). Fail with a typed,
      // node-attributed error instead of silently dropping the slot.
      throw new FXCompilerErrorException({
        code: "output-not-produced",
        message: `node "${binding.from.nodeId}" is bound to output slot "${binding.slot}" but produced no value for socket "${binding.from.socketKey}"`,
        nodeId: binding.from.nodeId,
        socketKey: binding.from.socketKey,
        slot: binding.slot,
        params: {
          nodeId: binding.from.nodeId,
          slot: binding.slot,
          socketKey: binding.from.socketKey,
        },
      });
    }

    const producerOutput = outputSocket(producer, binding.from.socketKey);
    const producerType =
      producerOutput === undefined
        ? undefined
        : socketConcreteType(binding.from.nodeId, producerOutput, resolution.types);
    // Bring the value into the slot's stage (a same-stage promote is a no-op), then
    // adapt a mismatched numeric width to the slot's declared type.
    const carried = state.promote(
      socketRefKey(binding.from),
      producerVariable,
      producerType ?? slotDefinition.type,
      stageOf(binding.from.nodeId),
      slotDefinition.stage,
    );
    outputs[binding.slot] = coerceSlotOutput(
      state,
      slotDefinition.stage,
      carried,
      producerType,
      slotDefinition.type,
    );
  }

  return state.assemble(
    outputs,
    structuralHash(
      graph,
      renderTargetSignature(target),
      order,
      renderNodeKey(resolution.types, stages),
    ),
  );
}
