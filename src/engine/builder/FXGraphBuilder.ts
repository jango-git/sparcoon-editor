import type { FXConnection, FXOutputBinding } from "../core/FXGraph";
import type { FXGraphSnapshotData, FXNodeData } from "../core/live/FXSnapshotData";
import { FX_SNAPSHOT_VERSION } from "../core/live/FXSnapshotData";
import type { FXNodeDefinition } from "../core/nodes/defineNode";
import type { FXNodeMeta } from "../core/nodes/FXSocketSpec";
import { FX_STANDARD_NODES } from "../nodes-std/index";

export interface FXOutHandle {
  readonly nodeId: string;
  readonly socketKey: string;
}

export type FXBuilderParams = Readonly<Record<string, unknown>>;

export type FXBuilderInputs = Readonly<Record<string, FXOutHandle>>;

export type FXNodeTypeRef = string | FXNodeDefinition;

export interface FXPipeOptions {
  readonly from?: string;
  readonly into?: string;
}

export class FXNodeHandle {
  constructor(
    public readonly id: string,
    private readonly builder: FXGraphBuilder,
    private readonly metadata: FXNodeMeta | undefined,
  ) {}

  public out(key: string): FXOutHandle {
    return { nodeId: this.id, socketKey: key };
  }

  /**
   * Adds `type` fed by this node's output. Sockets default to the unambiguous one. Pass
   * FXPipeOptions otherwise.
   */
  public pipe(
    type: FXNodeTypeRef,
    parameters?: FXBuilderParams,
    options?: FXPipeOptions,
  ): FXNodeHandle {
    const fromKey = options?.from ?? this.firstOutputKey();
    const target = this.builder.add(type, parameters);
    const intoKey = options?.into ?? target.soleInputKey();
    this.builder.connect(this.out(fromKey), target.out(intoKey));
    return target;
  }

  private firstOutputKey(): string {
    if (this.metadata === undefined) {
      throw new Error(
        `FXGraphBuilder.pipe: cannot infer the source output of "${this.id}" without node metadata - pass { from }`,
      );
    }
    const firstOutput = this.metadata.outputs[0];
    if (firstOutput === undefined) {
      throw new Error(`FXGraphBuilder.pipe: node "${this.id}" has no output to pipe from`);
    }
    return firstOutput.key;
  }

  private soleInputKey(): string {
    if (this.metadata === undefined) {
      throw new Error(
        `FXGraphBuilder.pipe: cannot infer the target input of "${this.id}" without node metadata - pass { into }`,
      );
    }
    // One required input is the target. Otherwise the first input, which nodes declare as their
    // primary flow input. `{ into }` overrides.
    const required = this.metadata.inputs.filter((socket) => socket.required === true);
    const pick = required.length === 1 ? required[0] : this.metadata.inputs[0];
    if (pick === undefined) {
      throw new Error(
        `FXGraphBuilder.pipe: node "${this.id}" has no input to pipe into - it takes none`,
      );
    }
    return pick.key;
  }
}

/**
 * Code-first assembler of an FXGraphSnapshotData. Node ids are `${type}#${index}` (per-type
 * counter), so rerunning gives the same ids, which a live rebind needs. Prefer buildRenderGraph /
 * buildBehaviorGraph, which supply node metadata for `pipe`.
 */
export class FXGraphBuilder {
  private readonly counters = new Map<string, number>();
  private readonly nodes: Record<string, FXNodeData> = {};
  private readonly connectionsList: FXConnection[] = [];
  private readonly bindingsList: FXOutputBinding[] = [];

  constructor(private readonly resolveMeta?: (type: string) => FXNodeMeta | undefined) {}

  public add(
    type: FXNodeTypeRef,
    parameters?: FXBuilderParams,
    inputs?: FXBuilderInputs,
  ): FXNodeHandle {
    const typeName = typeof type === "string" ? type : type.type;
    const index = this.counters.get(typeName) ?? 0;
    this.counters.set(typeName, index + 1);
    const id = `${typeName}#${index.toString()}`;

    this.nodes[id] =
      parameters === undefined ? { type: typeName } : { type: typeName, params: parameters };

    if (inputs !== undefined) {
      for (const [socketKey, from] of Object.entries(inputs)) {
        this.connectionsList.push({ from, to: { nodeId: id, socketKey } });
      }
    }

    return new FXNodeHandle(id, this, this.metaFor(type));
  }

  public connect(from: FXOutHandle, to: FXOutHandle): this {
    this.connectionsList.push({ from, to });
    return this;
  }

  public bind(slot: string, from: FXOutHandle): this {
    this.bindingsList.push({ slot, from });
    return this;
  }

  public build(): FXGraphSnapshotData {
    return {
      version: FX_SNAPSHOT_VERSION,
      nodes: this.nodes,
      connections: this.connectionsList,
      outputBindings: this.bindingsList,
    };
  }

  private metaFor(type: FXNodeTypeRef): FXNodeMeta | undefined {
    if (typeof type !== "string") {
      return type.describe();
    }
    return this.resolveMeta?.(type);
  }
}

function standardMetaResolver(
  domain: "render" | "behavior",
): (type: string) => FXNodeMeta | undefined {
  const byType = new Map<string, FXNodeMeta>();
  for (const definition of FX_STANDARD_NODES) {
    if (definition.domain === domain || definition.domain === "shared") {
      byType.set(definition.type, definition.describe());
    }
  }
  return (type) => byType.get(type);
}

/**
 * Assembles a render-graph snapshot code-first.
 *
 * @example
 * ```ts
 * const data = buildRenderGraph((builder) => {
 *   const color = builder.add("constant", { value: [0.6, 0.6, 0.7, 1], type: "vec4" });
 *   const clip = builder.add("spherical-clip", { innerRadius: 0.2 }, { color: color.out("out") });
 *   builder.bind("albedo", clip.out("color"));
 * });
 * ```
 */
export function buildRenderGraph(
  buildCallback: (builder: FXGraphBuilder) => void,
): FXGraphSnapshotData {
  const builder = new FXGraphBuilder(standardMetaResolver("render"));
  buildCallback(builder);
  return builder.build();
}

/** Assembles a behavior-graph snapshot code-first. */
export function buildBehaviorGraph(
  buildCallback: (builder: FXGraphBuilder) => void,
): FXGraphSnapshotData {
  const builder = new FXGraphBuilder(standardMetaResolver("behavior"));
  buildCallback(builder);
  return builder.build();
}
