import type { FXExpr } from "../ir/FXExpr";
import { coerceNumeric } from "../ir/FXExprBuilder";
import type { FXGraph } from "../FXGraph";
import type { FXGraphNode } from "../FXGraphNode";
import type { FXSocketRef } from "../socket/FXSocket";
import { socketRefKey } from "../socket/FXSocket";
import type { FXValueType } from "../socket/FXValueType";
import { inputSocket, outputSocket } from "./FXSocketIndex.Internal";
import { socketConcreteType } from "./FXTypeResolve.Internal";

/**
 * Backend-neutral core shared by the render ({@link FXNodeCompilerContext}) and behavior
 * ({@link FXParticleKernelContext}) node contexts: input resolution, `hasInput`, `resolvedType`.
 */
export abstract class FXCompileContextBase<N extends FXGraphNode, V> {
  /** Backend-specific prefix for this context's throws (invariant guards on a validated graph). */
  protected abstract readonly contextLabel: string;

  constructor(
    protected readonly graph: FXGraph<N>,
    protected readonly node: N,
    protected readonly nodeId: string,
    protected readonly outputVariables: Map<string, V>,
    protected readonly types: ReadonlyMap<string, FXValueType>,
  ) {}

  public resolvedType(): FXValueType {
    const type = this.types.get(this.nodeId);
    if (type === undefined) {
      throw new Error(
        `${this.contextLabel}.resolvedType: node "${this.nodeId}" has no resolved generic type`,
      );
    }
    return type;
  }

  public hasInput(socketKey: string): boolean {
    return this.graph.sourceOf({ nodeId: this.nodeId, socketKey }) !== undefined;
  }

  public readInput(socketKey: string, fallback?: FXExpr): FXExpr {
    const connection = this.graph.sourceOf({ nodeId: this.nodeId, socketKey });
    if (connection === undefined) {
      if (fallback !== undefined) {
        return fallback;
      }
      throw new Error(
        `${this.contextLabel}.readInput: input "${socketKey}" of node "${this.nodeId}" is unconnected and no fallback was given`,
      );
    }
    const stored = this.outputVariables.get(socketRefKey(connection.from));
    const producer = this.graph.getNode(connection.from.nodeId);
    if (stored === undefined || producer === undefined) {
      throw new Error(
        `${this.contextLabel}.readInput: source of "${socketKey}" was not built before node "${this.nodeId}"`,
      );
    }
    const producerOutput = outputSocket(producer, connection.from.socketKey);
    if (producerOutput === undefined) {
      throw new Error(
        `${this.contextLabel}.readInput: node "${connection.from.nodeId}" has no output "${connection.from.socketKey}"`,
      );
    }
    const producerType = socketConcreteType(connection.from.nodeId, producerOutput, this.types);
    if (producerType === undefined) {
      throw new Error(
        `${this.contextLabel}.readInput: source of "${socketKey}" has an unresolved generic type`,
      );
    }
    const value = this.materializeProducer(stored, producerType, connection.from);
    return this.coerceToInput(socketKey, value);
  }

  /** Coerces a connected value to the concrete type of this node's input socket (pad/truncate/splat). */
  protected coerceToInput(socketKey: string, value: FXExpr): FXExpr {
    const socket = inputSocket(this.node, socketKey);
    if (socket === undefined) {
      return value;
    }
    const target = socketConcreteType(this.nodeId, socket, this.types);
    return target === undefined ? value : coerceNumeric(value, target);
  }

  /** SSA-local hint for an output socket: `<nodeType>_<socketKey>`. */
  protected outputHint(socketKey: string): string {
    return `${this.node.type}_${socketKey}`;
  }

  /**
   * Materializes a producer's stored output into a typed expression this node can read.
   * `from` identifies the producer socket (a render stage-promote needs it).
   */
  protected abstract materializeProducer(
    stored: V,
    producerType: FXValueType,
    from: FXSocketRef,
  ): FXExpr;
}
