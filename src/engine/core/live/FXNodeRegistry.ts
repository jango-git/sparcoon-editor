import type { FXGraphNode } from "../FXGraphNode";
import { FXCompilerErrorException } from "../compiler/FXCompilerError";

/** Reconstructs a node instance of one registered type from its serialized params. */
export type FXNodeFactory<N extends FXGraphNode> = (
  parameters: Readonly<Record<string, unknown>> | undefined,
) => N;

/**
 * Maps node `type` strings to factories, so the library can rebuild live node instances
 * from an editor snapshot it did not author. Populate once at setup, then hand to an
 * {@link FXGraphReconciler}.
 */
export class FXNodeRegistry<N extends FXGraphNode = FXGraphNode> {
  private readonly factories = new Map<string, FXNodeFactory<N>>();

  /** Registers a factory for a node type. Throws if the type is already registered. */
  public register(type: string, factory: FXNodeFactory<N>): void {
    if (this.factories.has(type)) {
      throw new Error(`FXNodeRegistry: node type "${type}" is already registered`);
    }
    this.factories.set(type, factory);
  }

  /** Whether a factory is registered for `type`. */
  public has(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * Creates a fresh node of `type`. Throws on a type mismatch. The "no factory registered" case
   * (an unknown type) is an invariant-only backstop: every production caller checks {@link has}
   * first and skips the call otherwise, so it never actually fires - kept as a plain `Error`, not
   * worth a dedicated code.
   */
  public create(type: string, parameters?: Readonly<Record<string, unknown>>): N {
    const factory = this.factories.get(type);
    if (factory === undefined) {
      throw new Error(`FXNodeRegistry: no factory registered for node type "${type}"`);
    }
    const node = factory(parameters);
    if (node.type !== type) {
      throw new FXCompilerErrorException({
        code: "node-factory-type-mismatch",
        message: `FXNodeRegistry: factory for "${type}" produced a node of type "${node.type}"`,
        params: { requestedType: type, producedType: node.type },
      });
    }
    return node;
  }
}
