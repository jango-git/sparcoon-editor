import type { FXExpr } from "../ir/FXExpr";
import type { FXExprBuilderApi } from "../ir/FXExprBuilder";
import type { FXValueType } from "../socket/FXValueType";

/** Publishes an edited value into a value parameter's live resource(s); held by the node. */
export interface FXValueParamHandle {
  /** Pushes a new scalar/vector value into the backend's uniform / bindings (a rebind). */
  update(value: number | readonly number[]): void;
}

/** A value parameter allocated by a backend: the expression reading it, and its live handle. */
export interface FXValueParam {
  /** Expression reading the allocated value - a uniform/binding ref, or a `construct` for a vector. */
  readonly expr: FXExpr;
  readonly handle: FXValueParamHandle;
}

/**
 * Backend-neutral API handed to {@link FXGraphNode.build} - a node's only channel to the
 * compiler. Codegen is SSA-style: every output is a named local, computed once even if shared.
 */
export interface FXCompilerContext {
  /** The IR-builder facade for a node's `build`, with `call` bound to this backend's signature registry. */
  readonly builders: FXExprBuilderApi;

  /** Whether the given input socket has a connected source. */
  hasInput(socketKey: string): boolean;

  /**
   * The value feeding an input socket as a typed expression (an SSA local ref, or for a
   * behavior vector a `construct`). Returns `fallback` when unconnected; throws without one.
   */
  readInput(socketKey: string, fallback?: FXExpr): FXExpr;

  /** Registers the expression this node produces on an output socket as a named SSA local. */
  setOutput(socketKey: string, expression: FXExpr): void;

  /** Reads a host-provided builtin declared by the target, as a ref expression. */
  readTargetInput(name: string): FXExpr;

  /**
   * Allocates a live-tunable value parameter as this backend's resource (uniform / per-component
   * binding), returning the read expression plus a handle to publish edits without recompiling.
   */
  allocateValueParam(
    type: FXValueType,
    value: number | readonly number[],
    hint: string,
  ): FXValueParam;

  /** The concrete type this node's generic `T` resolved to (via {@link resolveGenerics}); throws if unresolved. */
  resolvedType(): FXValueType;

  /**
   * Materializes `expr` into a named SSA local and returns a ref reading it back, so a shared
   * sub-expression (normalization, cross products) is computed once instead of duplicated.
   */
  defineLocal(hint: string, expr: FXExpr): FXExpr;

  /** Allocates a collision-free identifier scoped to this compilation. */
  uniqueName(hint: string): string;

  /** Appends a helper (function/snippet), deduplicated by `key`. */
  emitHelper(key: string, source: string): void;
}
