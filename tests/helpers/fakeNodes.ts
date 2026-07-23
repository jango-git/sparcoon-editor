import type { FXValidationResult } from "../../src/engine/core/compiler/FXCompilerError";
import {
  collectReachableNodeIds,
  topologicalOrder,
} from "../../src/engine/core/compiler/FXGraphTraversal.Internal";
import { structuralHash } from "../../src/engine/core/compiler/FXStructuralHash.Internal";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import { FXGraphNode } from "../../src/engine/core/FXGraphNode";
import type { FXLiveBackend } from "../../src/engine/core/live/FXLiveBackend";
import { FXNodeRegistry } from "../../src/engine/core/live/FXNodeRegistry";
import type { FXAttributeRequest } from "../../src/engine/core/socket/FXAttribute";
import type { FXSocketDescriptor } from "../../src/engine/core/socket/FXSocket";
import type { FXGLSLTypeName } from "../../src/engine/core/socket/FXValueType";
import { resolveValueType } from "../../src/engine/core/socket/FXValueType";

/** Builds a socket descriptor with the minimum of ceremony the tests need. */
export function socket(
  key: string,
  type: FXGLSLTypeName = "float",
  opts?: { required?: boolean; defaultValue?: unknown },
): FXSocketDescriptor {
  return {
    key,
    type: resolveValueType(type),
    required: opts?.required,
    defaultValue: opts?.defaultValue,
  };
}

/** Static shape of a {@link FakeNode}. */
export interface FakeNodeConfig {
  readonly type: string;
  readonly inputs?: readonly FXSocketDescriptor[];
  readonly outputs?: readonly FXSocketDescriptor[];
  /** Initial `cacheKey()` value; mutate `node.variant` to flip the recompile gate. */
  readonly variant?: string;
  /** Per-particle attribute this node reserves (for collector tests). */
  readonly attributeRequest?: FXAttributeRequest;
  /** Declared target-input reads, surfaced through `targetReads` (undefined = undeclared). */
  readonly targetReads?: readonly string[];
  /** Stage the node runs in, read by validation's stage-legality check. */
  readonly stage?: string;
  /** When it returns true, `prepare()` throws - lets a test drive a prepare failure/retry. */
  readonly prepareThrows?: () => boolean;
}

/**
 * Minimal, instrumented {@link FXGraphNode} for core tests. Carries configurable
 * sockets, a mutable `variant` feeding `cacheKey()`, and lifecycle spies so tests
 * can assert prepare/destroy/applyParams/syncLiveValues were (or were not) called.
 */
export class FakeNode extends FXGraphNode {
  public readonly type: string;
  public readonly inputs: readonly FXSocketDescriptor[];
  public readonly outputs: readonly FXSocketDescriptor[];
  public override readonly attributeRequest?: FXAttributeRequest;
  public readonly stage?: string;
  private readonly declaredReads?: readonly string[];
  private readonly prepareThrows?: () => boolean;

  public variant: string;
  public prepareCount = 0;
  public destroyCount = 0;
  public applyParamsCount = 0;
  public syncCount = 0;
  public lastParams: Readonly<Record<string, unknown>> | undefined;

  constructor(config: FakeNodeConfig) {
    super();
    this.type = config.type;
    this.inputs = config.inputs ?? [];
    this.outputs = config.outputs ?? [];
    this.attributeRequest = config.attributeRequest;
    this.stage = config.stage;
    this.declaredReads = config.targetReads;
    this.prepareThrows = config.prepareThrows;
    this.variant = config.variant ?? "";
  }

  public override get targetReads(): readonly string[] | undefined {
    return this.declaredReads;
  }

  public build(): void {
    // No-op: core tests use a fake backend and never invoke real code generation.
  }

  public override cacheKey(): string {
    return this.variant;
  }

  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    this.applyParamsCount += 1;
    this.lastParams = params;
    // Simulate a strict `coerce` rejecting a bad value: a snapshot carrying the
    // `forcedThrowMessage` sentinel makes applyParams throw, so live-apply's guard
    // can be exercised without wiring a real descriptor node.
    if (params["forcedThrowMessage"] !== undefined) {
      throw new Error(String(params["forcedThrowMessage"]));
    }
  }

  public override syncLiveValues(): void {
    this.syncCount += 1;
  }

  public override prepare(): void {
    this.prepareCount += 1;
    if (this.prepareThrows?.() === true) {
      throw new Error("prepare boom");
    }
  }

  public override destroy(): void {
    this.destroyCount += 1;
  }
}

/** A node type the registry knows how to build. */
export interface FakeTypeConfig {
  readonly type: string;
  readonly inputs?: readonly FXSocketDescriptor[];
  readonly outputs?: readonly FXSocketDescriptor[];
  readonly targetReads?: readonly string[];
  readonly stage?: string;
  /** When it returns true, `prepare()` throws - lets a test drive a prepare failure/retry. */
  readonly prepareThrows?: () => boolean;
}

/**
 * Builds a registry over the given fake node types. The returned `created` array
 * records every instance the registry minted, in creation order, so tests can
 * reach the live instances an {@link FXLiveGraph} keeps private.
 */
export function makeRegistry(configs: readonly FakeTypeConfig[]): {
  registry: FXNodeRegistry<FakeNode>;
  created: FakeNode[];
} {
  const registry = new FXNodeRegistry<FakeNode>();
  const created: FakeNode[] = [];
  for (const config of configs) {
    registry.register(config.type, () => {
      const node = new FakeNode(config);
      created.push(node);
      return node;
    });
  }
  return { registry, created };
}

/** Compiled artifact the {@link FakeBackend} produces - just the gate hash. */
export interface FakeArtifact {
  readonly hash: string;
}

/**
 * A fake {@link FXLiveBackend} that computes a real {@link structuralHash} (so the
 * recompile/rebind gate behaves faithfully) while counting compiles and installs.
 * Set {@link forceInvalid} to simulate a graph the editor pushed mid-edit that must
 * not compile.
 */
export class FakeBackend implements FXLiveBackend<FakeNode, FakeArtifact> {
  public compileCount = 0;
  public installCount = 0;
  public forceInvalid = false;
  /** Simulate a node that validates but throws in build() - exercises apply's hold. */
  public compileThrows = false;
  /** Simulate host target-derivation/hashing throwing inside previewHash (L8). */
  public previewHashThrows = false;

  public constructor(private readonly targetName = "fake") {}

  public validate(_graph: FXGraph<FakeNode>): FXValidationResult {
    if (this.forceInvalid) {
      return {
        ok: false,
        errors: [{ code: "cycle", message: "forced invalid for test" }],
      };
    }
    return { ok: true, errors: [] };
  }

  public previewHash(graph: FXGraph<FakeNode>): string {
    if (this.previewHashThrows) {
      throw new Error("previewHash boom");
    }
    const reachable = collectReachableNodeIds(graph);
    const { order } = topologicalOrder(graph, reachable);
    return structuralHash(graph, this.targetName, order);
  }

  public compile(graph: FXGraph<FakeNode>): FakeArtifact {
    this.compileCount += 1;
    if (this.compileThrows) {
      throw new Error("compile boom");
    }
    return { hash: this.previewHash(graph) };
  }

  public install(_artifact: FakeArtifact): void {
    this.installCount += 1;
  }
}
