import type { FXConnection, FXOutputBinding } from "../core/FXGraph";
import type { FXGraphSnapshotData, FXNodeData } from "../core/live/FXSnapshotData";
import { FX_SNAPSHOT_VERSION } from "../core/live/FXSnapshotData";
import type { FXNodeDefinition } from "../core/nodes/defineNode";
import type { FXNodeMeta } from "../core/nodes/FXSocketSpec";
import { FX_STANDARD_NODES } from "../nodes-std/index";

/** A reference to one output socket of a builder node. */
export interface FXOutHandle {
  readonly nodeId: string;
  readonly socketKey: string;
}

/** Plain-data parameter bag for a node, matching what a snapshot serializes. */
export type FXBuilderParams = Readonly<Record<string, unknown>>;

/** Map of a node's input socket keys to the output handles feeding them. */
export type FXBuilderInputs = Readonly<Record<string, FXOutHandle>>;

/** What {@link FXGraphBuilder.add} accepts as a node type: a registered `type` string or a definition carrying it. */
export type FXNodeTypeRef = string | FXNodeDefinition;

/** Explicit socket overrides for {@link FXNodeHandle.pipe} when auto-resolution is ambiguous. */
export interface FXPipeOptions {
  /** Output socket key on the source node (defaults to its first output). */
  readonly from?: string;
  /** Input socket key on the piped node (defaults to its sole/only-required input). */
  readonly into?: string;
}

/** A handle to a node just added to an {@link FXGraphBuilder}. */
export class FXNodeHandle {
  constructor(
    public readonly id: string,
    private readonly builder: FXGraphBuilder,
    private readonly metadata: FXNodeMeta | undefined,
  ) {}

  /** A reference to the output socket `key` of this node. */
  public out(key: string): FXOutHandle {
    return { nodeId: this.id, socketKey: key };
  }

  /**
   * Sugar: adds `type` fed by this node's output and returns the new handle. Source/target
   * sockets default to each node's unambiguous socket; pass {@link FXPipeOptions} to disambiguate.
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
    // A single required input is the unambiguous pipe target. Otherwise fall back to the
    // node's first input: by convention a node declares its primary flow input first and
    // its editable "value on the pin" config inputs (which carry their own defaults and
    // are rarely piped into) after, so the first input is the natural target. `{ into }`
    // overrides this for the exceptions.
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
 * Code-first assembler for an {@link FXGraphSnapshotData}. It builds *exactly* the wire format
 * an editor would serialize - there is no second path around snapshots, so a builder-authored
 * graph and an editor-authored one compile identically.
 *
 * Node ids are generated deterministically as `${type}#${index}` (a per-type counter in
 * insertion order), so re-running the same builder produces stable ids - the precondition for a
 * live rebind when only values changed.
 *
 * Prefer {@link buildRenderGraph} / {@link buildBehaviorGraph}, which wire in the standard-library
 * metadata so {@link FXNodeHandle.pipe} can resolve default sockets.
 */
export class FXGraphBuilder {
  private readonly counters = new Map<string, number>();
  private readonly nodes: Record<string, FXNodeData> = {};
  private readonly connectionsList: FXConnection[] = [];
  private readonly bindingsList: FXOutputBinding[] = [];

  /**
   * @param resolveMeta - Optional node-metadata lookup by type, used to resolve
   * default sockets in {@link FXNodeHandle.pipe}. Omitted for a bare builder.
   */
  constructor(private readonly resolveMeta?: (type: string) => FXNodeMeta | undefined) {}

  /**
   * Adds a node of `type` with optional `parameters` and pre-wired `inputs`
   * (socketKey -> source handle). Returns a {@link FXNodeHandle} for further wiring.
   */
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

  /** Connects an output handle to a specific input socket on a node. */
  public connect(from: FXOutHandle, to: FXOutHandle): this {
    this.connectionsList.push({ from, to });
    return this;
  }

  /** Binds a node output to one of the target's output slots (e.g. `"albedo"`, `"velocity"`). */
  public bind(slot: string, from: FXOutHandle): this {
    this.bindingsList.push({ slot, from });
    return this;
  }

  /** Produces the finished snapshot - the same wire format an editor emits. */
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

/** Builds a by-type metadata lookup over the standard nodes applicable to `domain`. */
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
 * Assembles a render-graph snapshot code-first. The builder handed to `buildCallback` knows
 * the standard render/shared node metadata, so {@link FXNodeHandle.pipe} resolves
 * default sockets.
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

/**
 * Assembles a behavior-graph snapshot code-first. The builder handed to `buildCallback` knows
 * the standard behavior/shared node metadata, so {@link FXNodeHandle.pipe} resolves
 * default sockets.
 */
export function buildBehaviorGraph(
  buildCallback: (builder: FXGraphBuilder) => void,
): FXGraphSnapshotData {
  const builder = new FXGraphBuilder(standardMetaResolver("behavior"));
  buildCallback(builder);
  return builder.build();
}
