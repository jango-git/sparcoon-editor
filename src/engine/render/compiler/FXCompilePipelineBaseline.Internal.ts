import { printGLSLBaseline } from "../../core/codegen/printGLSLBaseline.Internal";
import type { FXRatedLocal } from "../../core/codegen/rates.Internal";
import { FXGLSLNames } from "../../core/codegen/uniqueName.Internal";
import type { FXRenderCapabilities } from "../../core/compiler/collectRenderCapabilities";
import { collectRenderCapabilities } from "../../core/compiler/collectRenderCapabilities";
import { buildNodes, prepareCompile } from "../../core/compiler/compileDriver.Internal";
import { FXCompileContextBase } from "../../core/compiler/FXCompileContextBase";
import type { FXValueParam } from "../../core/compiler/FXCompilerContext";
import type { FXCompilerError } from "../../core/compiler/FXCompilerError";
import { FXCompilerErrorException } from "../../core/compiler/FXCompilerError";
import {
  collectReachableNodeIds,
  topologicalOrder,
} from "../../core/compiler/FXGraphTraversal.Internal";
import { outputSocket } from "../../core/compiler/FXSocketIndex.Internal";
import { structuralHash } from "../../core/compiler/FXStructuralHash.Internal";
import { genericTypeTag, socketConcreteType } from "../../core/compiler/FXTypeResolve.Internal";
import { resolvePlacement } from "../../core/compiler/placement.Internal";
import type { FXGraph } from "../../core/FXGraph";
import type { FXExpr } from "../../core/ir/FXExpr";
import type { FXExprBuilderApi } from "../../core/ir/FXExprBuilder";
import { coerceNumeric, createBuilders, ref } from "../../core/ir/FXExprBuilder";
import { baselineSignaturesFrom, FX_FUNCTIONS } from "../../core/ir/FXFunctions.Internal";
import { collectGLSLHelper, type FXGLSLHelperName } from "../../core/ir/FXHelpers.Internal";
import type { FXSocketRef } from "../../core/socket/FXSocket";
import { socketRefKey } from "../../core/socket/FXSocket";
import type { FXValueType } from "../../core/socket/FXValueType";
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
import {
  finalizeRenderPrograms,
  type FXPrintedStage,
  FXRenderUniforms,
  type FXSlotValue,
} from "./FXRenderCompileShared.Internal";
import type { FXRenderContext } from "./FXRenderContext";

/**
 * Render compiler pipeline of the WebGL1 tier (GLSL ES 1.00). It is a separate copy of the standard
 * tier's pipeline, so the tiers can diverge. Shading-language-neutral steps (placement, uniform
 * table, stage finishing) are called from FXRenderStagePlacement and FXRenderCompileShared.
 */

/** This tier's bound builders - baseline signatures only (`standardOnly` functions excluded, so
 *  `fn.call` throws for one reached with no `baselineBuild`). */
const BASELINE_BUILDERS: FXExprBuilderApi = createBuilders(baselineSignaturesFrom(FX_FUNCTIONS));

function isReachableStage(producer: FXShaderStage, consumer: FXShaderStage): boolean {
  return (
    producer === consumer ||
    (producer === FXShaderStage.VERTEX && consumer === FXShaderStage.FRAGMENT)
  );
}

/**
 * Infers each node's stage. A flexible node goes to `vertex` if any consumer needs it there (vertex
 * promotes to fragment), else `fragment`.
 */
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

/** Hash tag of a flexible node's placement, so moving it between stages recompiles. */
function stageTag(
  stages: ReadonlyMap<string, FXShaderStage>,
  id: string,
  node: FXRenderNode,
): string {
  return node.stageFlexible ? `@${stages.get(id) ?? ""}` : "";
}

export function renderNodeKey(
  types: ReadonlyMap<string, FXValueType>,
  stages: ReadonlyMap<string, FXShaderStage>,
): (id: string, node: FXRenderNode) => string {
  return (id, node) => genericTypeTag(types, id) + stageTag(stages, id, node);
}

/**
 * Checks that reachable values flow vertex to fragment only. Vertex-to-fragment promotion is
 * GLSL-specific, so this is not in the core validator.
 */
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

interface FXStageLocal extends FXRatedLocal {
  readonly type: FXValueType;
  readonly owner: string | undefined;
}

class FXCompileState {
  private readonly names = new FXGLSLNames();

  private readonly uniforms = new FXRenderUniforms(() => this.uniqueName());
  private readonly varyingList: FXVarying[] = [];
  /** Each stage's locals as their nodes emitted them, until {@link finalize} places and prints them. */
  private readonly locals: Record<FXShaderStage, FXStageLocal[]> = {
    [FXShaderStage.VERTEX]: [],
    [FXShaderStage.FRAGMENT]: [],
  };
  /** The helpers each node links: they go wherever its locals end up. */
  private readonly ownerHelpers = new Map<string, FXGLSLHelperName[]>();

  public uniqueName(): string {
    return this.names.next();
  }

  /** Adds a local to a stage - where its node runs; {@link finalize} may still move it. */
  public emitLocal(stage: FXShaderStage, local: FXStageLocal): void {
    this.locals[stage].push(local);
  }

  /** Links a helper a node calls into every stage that ends up holding one of the node's locals. */
  public emitHelper(owner: string, helper: FXGLSLHelperName): void {
    this.ownerHelpers.set(owner, [...(this.ownerHelpers.get(owner) ?? []), helper]);
  }

  public allocateUniform(descriptor: FXUniformDescriptor): FXUniformHandle {
    return this.uniforms.allocate(descriptor);
  }

  public allocateVarying(
    type: FXValueType,
    interpolation: FXVarying["interpolation"] = "smooth",
  ): string {
    const name = this.uniqueName();
    this.varyingList.push({ name, type, interpolation });
    return name;
  }

  /**
   * Places and prints the graph's programs (see `finalizeRenderPrograms`). Each value a program
   * carries between its stages rides one varying, marked `flat` when it is the same at all of a primitive's vertices: the runtime declares it
   * `flat` where the context's GLSL has it, and this tier's GLSL ES 1.00 interpolates it back to
   * itself (this tier has no integer types, which would need it).
   */
  public finalize(
    target: FXTarget,
    slots: ReadonlyMap<string, FXSlotValue>,
    capabilities: FXRenderCapabilities,
    hash: string,
  ): FXCompiledShader {
    return finalizeRenderPrograms(target, slots, capabilities, hash, {
      tier: "baseline",
      vertex: this.locals[FXShaderStage.VERTEX],
      fragment: this.locals[FXShaderStage.FRAGMENT],
      uniforms: this.uniforms,
      nodeVaryings: this.varyingList,
      uniqueName: () => this.uniqueName(),
      isFlat: (_local, perPrimitive) => perPrimitive,
      printStage: (locals, carried) => this.printStage(locals, carried),
    });
  }

  /** Prints `locals` as a stage's body, reading each local in `carried` through its varying -
   *  with the helpers it pulls in and the target inputs it reads. */
  private printStage(
    locals: readonly FXStageLocal[],
    carried: ReadonlyMap<string, string>,
  ): FXPrintedStage {
    const helpers = new Set<FXGLSLHelperName>();
    const targetReads = new Set<string>();
    const body: string[] = [];
    for (const local of locals) {
      const owned = local.owner === undefined ? undefined : this.ownerHelpers.get(local.owner);
      for (const helper of owned ?? []) {
        collectGLSLHelper(helpers, "baseline", helper);
      }
      const printed = printGLSLBaseline(local.expr, FX_FUNCTIONS, (reference) => {
        if (reference.ref === "targetInput") {
          targetReads.add(reference.name);
        }
        return reference.ref === "local"
          ? (carried.get(reference.name) ?? reference.name)
          : reference.name;
      });
      for (const helper of printed.helpers) {
        helpers.add(helper);
      }
      body.push(`${local.type.glslTypeName} ${local.name} = ${printed.code};`);
    }
    return {
      helpers: [...helpers],
      body,
      targetReads: [...targetReads].sort(),
    };
  }
}

/** FXRenderContext bound to one node, forwarding emissions to FXCompileState. */
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
    return BASELINE_BUILDERS;
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

    const key = socketRefKey({ nodeId: this.nodeId, socketKey });
    if (
      expression.kind === "ref" &&
      expression.ref === "local" &&
      expression.type.glslTypeName === socketType.glslTypeName
    ) {
      // Already a local of the socket's type: consumers read it, with no alias of it in between.
      this.outputVariables.set(key, expression.name);
    } else if (socketType.instantiable) {
      const name = this.state.uniqueName();
      this.state.emitLocal(this.stage, {
        name,
        type: socketType,
        expr: expression,
        owner: this.nodeId,
      });
      this.outputVariables.set(key, name);
    } else {
      // Opaque types (e.g. samplers) cannot be locals; pass the reference through.
      this.outputVariables.set(key, printGLSLBaseline(expression, FX_FUNCTIONS).code);
    }
  }

  public defineLocal(_hint: string, expression: FXExpr): FXExpr {
    const name = this.state.uniqueName();
    this.state.emitLocal(this.stage, {
      name,
      type: expression.type,
      expr: expression,
      owner: this.nodeId,
    });
    return ref("local", name, expression.type);
  }

  public readTargetInput(name: string): FXExpr {
    // Throw a typed error so the live apply keeps the code and nodeId.
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

  public uniqueName(): string {
    return this.state.uniqueName();
  }

  public allocateUniform(descriptor: FXUniformDescriptor): FXUniformHandle {
    return this.state.allocateUniform(descriptor);
  }

  /** A value param is one uniform (vecN native); edits publish by rewriting its value. */
  public allocateValueParam(
    type: FXValueType,
    value: number | readonly number[],
    _hint: string,
  ): FXValueParam {
    const handle = this.allocateUniform({
      type,
      value: typeof value === "number" ? value : value.slice(),
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

  public allocateVarying(type: FXValueType): string {
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
    return this.state.allocateVarying(type);
  }

  public emitHelper(helper: FXGLSLHelperName): void {
    this.state.emitHelper(this.nodeId, helper);
  }

  /** Reads a producer local - a vertex one read here in the fragment stage crosses through a
   *  varying, which the compile state allocates when it places and prints the stages. */
  protected override materializeProducer(
    producerVariable: string,
    producerType: FXValueType,
    from: FXSocketRef,
  ): FXExpr {
    if (!producerType.instantiable && this.stageOf(from.nodeId) !== this.stage) {
      // A non-instantiable (opaque) type - a `sampler2D` - cannot ride a varying:
      // `varying sampler2D v_bridge;` is illegal GLSL. Type validation and
      // `validateStageDirection` (direction only) both pass such an edge, so reject
      // it here with a typed error the live layer folds into `invalid`.
      throw new FXCompilerErrorException({
        code: "opaque-type-crosses-stage",
        message: `opaque type ${producerType.id} cannot cross shader stages through a varying`,
        nodeId: from.nodeId,
        params: { typeId: producerType.id },
      });
    }
    return ref("local", producerVariable, producerType);
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
  const name = state.uniqueName();
  state.emitLocal(stage, {
    name,
    type: toType,
    expr: coerceNumeric(ref("local", variable, fromType), toType),
    owner: undefined,
  });
  return name;
}

export function compileGraphBaseline(
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
    // Prefers the node's baseline fallback when it declared one (see FXNodeDescriptor.baselineBuild);
    // otherwise the same primary `build` FXCompilerStandard would run.
    if (node.baselineBuild !== undefined) {
      node.baselineBuild(context);
    } else {
      node.build(context);
    }
  });

  const targetOutputs = new Map<string, FXTargetOutput>(
    target.outputs.map((output): [string, FXTargetOutput] => [output.slot, output]),
  );
  const slots = new Map<string, FXSlotValue>();

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
    // Adapt a mismatched numeric width to the slot's declared type, in the slot's stage (a
    // vertex producer read by a fragment slot crosses when the state places the stages).
    slots.set(binding.slot, {
      stage: slotDefinition.stage,
      value: coerceSlotOutput(
        state,
        slotDefinition.stage,
        producerVariable,
        producerType,
        slotDefinition.type,
      ),
    });
  }

  return state.finalize(
    target,
    slots,
    collectRenderCapabilities(graph),
    structuralHash(
      graph,
      renderTargetSignature(target),
      order,
      renderNodeKey(resolution.types, stages),
    ),
  );
}
