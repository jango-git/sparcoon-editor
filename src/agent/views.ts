/**
 * The agent API's data vocabulary and its read-only JSON projections of the document: plain data,
 * ids as the edit calls take them, rotations in Euler degrees (the same form `scene.setTransform`
 * accepts), heavy payloads (asset bytes, baked geometry) left out. Every projection is a private
 * copy - the caller may change it freely without reaching the immutable document behind it.
 */

import { bindingSinkId } from "../domain/graphEdges";
import type { AttributeTypeName, GraphComment, GraphPosition } from "../domain/graphModel";
import { isSinkType } from "../domain/nodePalette";
import type { LiveApplyStatus, SourceState, TimelineEvent } from "../model/editorState";
import { resolveGraphOwner } from "../model/editorState";
import { quatToEuler, type Transform, type Vec3 } from "../model/transform";
import { targetGraph, type GraphTarget } from "./address.Internal";

/** Which of an owner's two graphs: the material (render) or the simulation (behavior). */
export type GraphName = "render" | "behavior";

/** A socket as the agent names it: a node id and that node's socket key. */
export interface SocketAddress {
  readonly node: string;
  readonly socket: string;
}

export interface TransformView {
  readonly position: Vec3;
  /** Euler angles in degrees, XYZ order. */
  readonly rotation: Vec3;
  readonly scale: Vec3;
}

export interface EmitterView {
  readonly id: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly transform: TransformView;
  readonly events: readonly TimelineEvent[];
}

export interface MeshView {
  readonly id: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly transform: TransformView;
}

export interface SceneView {
  /** The project name; renamed through `scene.rename(vfx.id, ...)` like the editor's root row. */
  readonly name: string;
  readonly timeline: { readonly duration: number; readonly fps: number };
  readonly vfx: { readonly id: string; readonly transform: TransformView };
  readonly emitters: readonly EmitterView[];
  readonly meshes: readonly MeshView[];
  /** The emitter or mesh the editor's graph panel (and the compile status) currently shows. */
  readonly activeOwnerId: string | undefined;
}

export interface NodeView {
  readonly id: string;
  readonly type: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly position: GraphPosition;
  /** A reserved output node: always present, not removable; its inputs are the graph's outputs. */
  readonly sink: boolean;
}

/** One wire. A wire into a sink input is stored as an output binding; here both look the same. */
export interface EdgeView {
  readonly from: SocketAddress;
  readonly to: SocketAddress;
}

export interface GraphView {
  readonly ownerId: string;
  readonly graph: GraphName;
  readonly nodes: readonly NodeView[];
  readonly edges: readonly EdgeView[];
  readonly attributes: readonly { readonly name: string; readonly type: AttributeTypeName }[];
  readonly comments: readonly GraphComment[];
}

export interface AssetsView {
  readonly textures: readonly {
    readonly name: string;
    readonly label: string;
    readonly width: number;
    readonly height: number;
  }[];
  readonly meshes: readonly {
    readonly name: string;
    readonly label: string;
    readonly vertexCount: number;
  }[];
  readonly environments: readonly {
    readonly name: string;
    readonly label: string;
    readonly byteSize: number;
  }[];
  readonly activeEnvironment: string | undefined;
}

export interface GraphStatusView {
  readonly status: LiveApplyStatus["status"];
  readonly messages: readonly string[];
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly nodeId?: string;
    readonly socketKey?: string;
    readonly slot?: string;
  }[];
}

export interface StatusView {
  readonly ownerId: string | undefined;
  readonly render: GraphStatusView | undefined;
  readonly behavior: GraphStatusView | undefined;
}

export function transformView(transform: Transform): TransformView {
  return {
    position: transform.position,
    rotation: quatToEuler(transform.rotation),
    scale: transform.scale,
  };
}

export function sceneView(source: SourceState): SceneView {
  const scene = source.scene;
  return structuredClone({
    name: source.name,
    timeline: { duration: source.timeline.duration, fps: source.timeline.fps },
    vfx: { id: scene.vfx.id, transform: transformView(scene.vfx.transform) },
    emitters: scene.emitters.map((emitter) => ({
      id: emitter.id,
      name: emitter.name,
      hidden: emitter.hidden === true,
      transform: transformView(emitter.transform),
      events: emitter.events,
    })),
    meshes: scene.meshes.map((mesh) => ({
      id: mesh.id,
      name: mesh.name,
      hidden: mesh.hidden === true,
      transform: transformView(mesh.transform),
    })),
    activeOwnerId: resolveGraphOwner(scene)?.id,
  });
}

export function graphView(source: SourceState, target: GraphTarget): GraphView {
  const authored = targetGraph(source, target);
  const connections: EdgeView[] = authored.connections.map((connection) => ({
    from: { node: connection.from.nodeId, socket: connection.from.socketKey },
    to: { node: connection.to.nodeId, socket: connection.to.socketKey },
  }));
  const bindings: EdgeView[] = authored.outputBindings.map((binding) => ({
    from: { node: binding.from.nodeId, socket: binding.from.socketKey },
    to: { node: bindingSinkId(target.kind, binding), socket: binding.slot },
  }));
  return structuredClone({
    ownerId: target.owner.id,
    graph: target.name,
    nodes: Object.values(authored.nodes).map((node) => ({
      id: node.id,
      type: node.type,
      params: node.parameters,
      position: node.position,
      sink: isSinkType(node.type),
    })),
    edges: [...connections, ...bindings],
    attributes: authored.attributes,
    comments: authored.comments,
  });
}

export function assetsView(source: SourceState): AssetsView {
  return {
    textures: source.assets.map((asset) => ({
      name: asset.name,
      label: asset.label,
      width: asset.width,
      height: asset.height,
    })),
    meshes: source.meshAssets.map((asset) => ({
      name: asset.name,
      label: asset.label,
      vertexCount: asset.geometry.position.length / 3,
    })),
    environments: source.environments.map((asset) => ({
      name: asset.name,
      label: asset.label,
      byteSize: asset.byteSize,
    })),
    activeEnvironment: source.activeEnvironmentName,
  };
}

export function graphStatusView(status: LiveApplyStatus | undefined): GraphStatusView | undefined {
  if (status === undefined) {
    return undefined;
  }
  return structuredClone({
    status: status.status,
    messages: status.messages,
    errors: (status.errors ?? []).map((error) => ({
      code: error.code,
      message: error.message,
      ...(error.nodeId !== undefined ? { nodeId: error.nodeId } : {}),
      ...(error.socketKey !== undefined ? { socketKey: error.socketKey } : {}),
      ...(error.slot !== undefined ? { slot: error.slot } : {}),
    })),
  });
}
