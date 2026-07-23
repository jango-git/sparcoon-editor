import type { FXCompilerContext } from "./compiler/FXCompilerContext";
import type { FXAttributeRequest } from "./socket/FXAttribute";
import type { FXSocketDescriptor } from "./socket/FXSocket";
import type { FXGLSLTypeName, FXValueType } from "./socket/FXValueType";

/**
 * Backend-agnostic base node: typed sockets + {@link build}, called in topo order. Knows
 * nothing about host/backend - everything crosses via the context (`TContext`) and the adapter.
 */
export abstract class FXGraphNode<TContext extends FXCompilerContext = FXCompilerContext> {
  /**
   * Per-particle attribute buffer this node reserves; {@link collectAttributeRequests} unions
   * these across the reachable graph to derive the emitter's buffer set. Absent for most nodes.
   */
  public readonly attributeRequest?: FXAttributeRequest | undefined;

  /**
   * Stable node-type identifier (e.g. `"color-over-life"`). Contributes to the
   * structural hash and to helper deduplication; must not depend on instance data.
   */
  public abstract readonly type: string;

  public abstract readonly inputs: readonly FXSocketDescriptor[];

  public abstract readonly outputs: readonly FXSocketDescriptor[];

  /**
   * Target-input builtins {@link build} may read, by name; validation rejects a node reading
   * an undeclared one before compile. `[]` means "reads nothing"; `undefined` means the node
   * doesn't declare (validation skips it - third-party nodes still throw at compile on a bad read).
   */
  public get targetReads(): readonly string[] | undefined {
    return undefined;
  }

  /**
   * Lighting intrinsic this node emits (e.g. `"fxLambertShade"`), an `fx_` ABI function the
   * graph calls but never defines; {@link collectLightingRequirements} unions these into capability.
   */
  public get lightingIntrinsic(): string | undefined {
    return undefined;
  }

  /**
   * Emits this node's code through the context: read inputs, allocate resources,
   * then register each output expression.
   */
  public abstract build(context: TContext): void;

  /**
   * Render-only: the baseline (WebGL1) compiler prefers this over {@link build} when present -
   * an alternate build for a node whose primary `build` reaches for a WebGL2-only capability
   * (see `FXNodeDescriptor.baselineBuild`). `FXCompilerStandard` never calls this; most nodes
   * never define it.
   */
  public baselineBuild?(context: TContext): void;

  /**
   * Program cache key contribution - change this **only** when generated code *shape* changes.
   * A runtime value here recompiles needlessly; a structural switch left out of it instead
   * rebinds when it should recompile, silently keeping the wrong shader.
   */
  public cacheKey?(): string;

  /**
   * Applies serialized parameters on every ingested snapshot (editor pushes data, not instances).
   * Must **not** touch compile-time handles - {@link syncLiveValues} publishes to those.
   */
  public applyParams?(parameters: Readonly<Record<string, unknown>>): void;

  /**
   * Pushes current values into uniform/binding handles retained from the last {@link build},
   * on a rebind (same hash, new values). Must be a safe no-op before first build / unreachable.
   */
  public syncLiveValues?(): void;

  /**
   * Concrete type for a generic output with no connected input to infer `T` from (a *source*
   * node, e.g. `constant`). `undefined` if `T` is always inferable from an input instead.
   */
  public resolveGenericHint?(): FXGLSLTypeName | undefined;

  /**
   * Complexity estimate in "one scalar float ALU op" units (`split`/`combine` cost 0); scales
   * with `resolvedT` component width (a `vecN` op costs N times a `float` one). `undefined` = 0.
   */
  public estimateCost?(resolvedT?: FXValueType): number;

  /** Optional one-time setup before the first compile. */
  public prepare?(): void;

  /** Optional resource release (textures, buffers, ...). */
  public destroy?(): void;
}
