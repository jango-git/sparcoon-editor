import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import { socketRefKey } from "../socket/FXSocket";
import type { FXValueType } from "../socket/FXValueType";
import { areTypesCompatible } from "../socket/FXValueType";
import type { FXCompilerError, FXValidationResult } from "./FXCompilerError";
import { collectReachableNodeIds, topologicalOrder } from "./FXGraphTraversal.Internal";
import { inputSocket, outputSocket } from "./FXSocketIndex.Internal";
import { resolveGenerics, socketConcreteType } from "./FXTypeResolve.Internal";

/** An output slot a target requires the graph to fill. */
export interface FXValidatableOutput {
  readonly slot: string;
  readonly type: FXValueType;
  readonly required: boolean;
}

/** A host-provided builtin the graph may read (the read side of a target). */
export interface FXValidatableInput {
  readonly name: string;
  /** Stages/phases legal to read in; omitted by targets with no stage dimension. */
  readonly stages?: readonly string[];
}

/**
 * The minimal target surface {@link validateGraph} needs - both the render {@link FXTarget}
 * and the behavior kernel target satisfy this structurally.
 */
export interface FXValidatableTarget {
  readonly name: string;
  readonly outputs: readonly FXValidatableOutput[];
  /** Builtins nodes may read; when present, each node's {@link FXGraphNode.targetReads} is checked against it. */
  readonly inputs?: readonly FXValidatableInput[];
}

/**
 * The stage/phase a node runs in, read structurally so core stays backend-free (render
 * nodes carry `stage`, behavior nodes `phase`). `undefined` skips the stage-legality check.
 */
function nodeStage(node: FXGraphNode): string | undefined {
  const stage = (node as FXGraphNode & { readonly stage?: unknown }).stage;
  return typeof stage === "string" ? stage : undefined;
}

/**
 * Validates a graph against a target for *compilability*, not editing legality. Only the
 * reachable subgraph is checked, so a broken unreachable branch never blocks a preview.
 */
export function validateGraph(graph: FXGraph, target: FXValidatableTarget): FXValidationResult {
  const errors: FXCompilerError[] = [];
  const reachable = collectReachableNodeIds(graph);
  const { order, cycleNodeId } = topologicalOrder(graph, reachable);

  // Unify generic types up front; checks below read resolved types through it.
  const resolution = resolveGenerics(graph, order);
  errors.push(...resolution.errors);

  // Count connections into each input among reachable consumers to spot duplicates.
  const inputConnectionCount = new Map<string, number>();
  for (const connection of graph.connections) {
    if (!reachable.has(connection.to.nodeId)) {
      continue;
    }
    const key = socketRefKey(connection.to);
    inputConnectionCount.set(key, (inputConnectionCount.get(key) ?? 0) + 1);
  }

  for (const id of reachable) {
    const node = graph.getNode(id);
    if (node === undefined) {
      errors.push({
        code: "unknown-node",
        message: `graph references unknown node "${id}"`,
        nodeId: id,
      });
      continue;
    }

    for (const input of node.inputs) {
      if ((inputConnectionCount.get(socketRefKey({ nodeId: id, socketKey: input.key })) ?? 0) > 1) {
        errors.push({
          code: "duplicate-input-connection",
          message: `input "${input.key}" of node "${id}" has more than one source`,
          nodeId: id,
          socketKey: input.key,
        });
      }

      const connection = graph.sourceOf({ nodeId: id, socketKey: input.key });
      if (connection === undefined) {
        if (input.required === true && input.defaultValue === undefined) {
          errors.push({
            code: "missing-required-input",
            message: `required input "${input.key}" of node "${id}" is unconnected`,
            nodeId: id,
            socketKey: input.key,
          });
        }
        continue;
      }

      const source = graph.getNode(connection.from.nodeId);
      if (source === undefined) {
        errors.push({
          code: "unknown-node",
          message: `input "${input.key}" of node "${id}" is fed by unknown node "${connection.from.nodeId}"`,
          nodeId: connection.from.nodeId,
        });
        continue;
      }

      const sourceOutput = outputSocket(source, connection.from.socketKey);
      if (sourceOutput === undefined) {
        errors.push({
          code: "unknown-socket",
          message: `node "${connection.from.nodeId}" has no output socket "${connection.from.socketKey}"`,
          nodeId: connection.from.nodeId,
          socketKey: connection.from.socketKey,
        });
        continue;
      }

      const fromType = socketConcreteType(connection.from.nodeId, sourceOutput, resolution.types);
      const toType = socketConcreteType(id, input, resolution.types);
      // A `undefined` side is an unresolved generic - already reported; don't pile on.
      if (fromType !== undefined && toType !== undefined && !areTypesCompatible(fromType, toType)) {
        errors.push({
          code: "type-mismatch",
          message: `cannot feed ${fromType.id} into ${toType.id} input "${input.key}" of node "${id}"`,
          nodeId: id,
          socketKey: input.key,
        });
      }
    }

    // Caught here, tied to the node, before compilation - otherwise `build` throws a
    // bare Error and can crash a live apply. Undeclared reads are skipped (third-party).
    const reads = node.targetReads;
    if (reads !== undefined && target.inputs !== undefined) {
      const stage = nodeStage(node);
      for (const name of reads) {
        const targetInput = target.inputs.find((candidate) => candidate.name === name);
        if (targetInput === undefined) {
          errors.push({
            code: "unknown-target-input",
            message: `node "${id}" reads target input "${name}", which target "${target.name}" does not provide`,
            nodeId: id,
          });
          continue;
        }
        if (
          targetInput.stages !== undefined &&
          stage !== undefined &&
          !targetInput.stages.some((legal) => legal === stage)
        ) {
          errors.push({
            code: "target-input-stage-mismatch",
            message: `node "${id}" reads target input "${name}" in the ${stage} stage, where it is not available`,
            nodeId: id,
            socketKey: name,
          });
        }
      }
    }
  }

  // A typo'd `to.socketKey` into an undeclared input is otherwise silently dropped,
  // and its producer can fall out of reachability entirely - mirror the output-side check.
  for (const connection of graph.connections) {
    if (!reachable.has(connection.to.nodeId)) {
      continue;
    }
    const consumer = graph.getNode(connection.to.nodeId);
    if (consumer === undefined) {
      continue;
    }
    if (inputSocket(consumer, connection.to.socketKey) === undefined) {
      errors.push({
        code: "unknown-socket",
        message: `node "${connection.to.nodeId}" has no input socket "${connection.to.socketKey}"`,
        nodeId: connection.to.nodeId,
        socketKey: connection.to.socketKey,
      });
    }
  }

  if (cycleNodeId !== undefined) {
    errors.push({
      code: "cycle",
      message: `graph contains a cycle through node "${cycleNodeId}"`,
      nodeId: cycleNodeId,
      params: { nodeId: cycleNodeId },
    });
  }

  const targetOutputs = new Map<string, FXValidatableOutput>(
    target.outputs.map((output): [string, FXValidatableOutput] => [output.slot, output]),
  );
  const boundSlots = new Set<string>();

  for (const binding of graph.outputBindings) {
    const slotDefinition = targetOutputs.get(binding.slot);
    if (slotDefinition === undefined) {
      errors.push({
        code: "unknown-output-slot",
        message: `target "${target.name}" declares no output slot "${binding.slot}"`,
        slot: binding.slot,
      });
    }

    if (boundSlots.has(binding.slot)) {
      errors.push({
        code: "duplicate-output-binding",
        message: `output slot "${binding.slot}" is bound more than once`,
        slot: binding.slot,
      });
    }
    boundSlots.add(binding.slot);

    const source = graph.getNode(binding.from.nodeId);
    if (source === undefined) {
      errors.push({
        code: "unknown-node",
        message: `output slot "${binding.slot}" is bound to unknown node "${binding.from.nodeId}"`,
        nodeId: binding.from.nodeId,
        slot: binding.slot,
      });
      continue;
    }

    const sourceOutput = outputSocket(source, binding.from.socketKey);
    if (sourceOutput === undefined) {
      errors.push({
        code: "unknown-socket",
        message: `node "${binding.from.nodeId}" has no output socket "${binding.from.socketKey}"`,
        nodeId: binding.from.nodeId,
        socketKey: binding.from.socketKey,
        slot: binding.slot,
      });
      continue;
    }

    const boundType = socketConcreteType(binding.from.nodeId, sourceOutput, resolution.types);
    if (
      slotDefinition !== undefined &&
      boundType !== undefined &&
      !areTypesCompatible(boundType, slotDefinition.type)
    ) {
      errors.push({
        code: "type-mismatch",
        message: `output slot "${binding.slot}" expects ${slotDefinition.type.id} but is bound to ${boundType.id}`,
        nodeId: binding.from.nodeId,
        socketKey: binding.from.socketKey,
        slot: binding.slot,
      });
    }
  }

  for (const output of target.outputs) {
    if (output.required && !boundSlots.has(output.slot)) {
      errors.push({
        code: "missing-required-output",
        message: `required output slot "${output.slot}" of target "${target.name}" is unbound`,
        slot: output.slot,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}
