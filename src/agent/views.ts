/**
 * The agent API's data vocabulary and its read-only JSON projections of the document: plain data,
 * ids as the edit calls take them, rotations in Euler degrees (the same form `scene.setTransform`
 * accepts), heavy payloads (asset bytes, baked geometry) left out. Every projection is a private
 * copy - the caller may change it freely without reaching the immutable document behind it.
 */

import type { FXKeyEase } from "sparcoon";
import { bindingSinkId } from "../domain/graphEdges";
import type { AttributeTypeName, GraphComment, GraphPosition } from "../domain/graphModel";
import { isSinkType } from "../domain/nodePalette";
import type {
  AnimationTrack,
  LiveApplyStatus,
  SourceState,
  TimelineEvent,
  DeathReaction,
} from "../model/editorState";
import { resolveGraphOwner } from "../model/editorState";
import {
  quatToEuler,
  type Quat,
  type Transform,
  type TransformChannel,
  type TransformTrack,
  type Vec3,
} from "../model/transform";
import { renderGraphLighting } from "../persistence/exportCompile";
import { targetGraph, type GraphTarget } from "./address.Internal";
import type { GraphName } from "../model/graphSlots";

/** Which of an owner's graphs: the material (render), the simulation (behavior), or an emitter's
 *  trail (render-kind, on the trail host) - see `model/graphSlots.ts`. */
export type { GraphName };

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

/** One transform channel's keys; a rotation key's value is in Euler degrees, as elsewhere here. */
export interface TransformTrackView {
  readonly channel: TransformChannel;
  readonly keys: readonly {
    readonly id: string;
    readonly time: number;
    readonly value: Vec3;
    readonly ease?: FXKeyEase;
  }[];
}

/** What an emitter and a mesh share on the timeline. */
export interface AnimatedView {
  readonly transformTracks: readonly TransformTrackView[];
  /** Timeline Value keys by name; a declared value with no keys has no track. */
  readonly tracks: readonly AnimationTrack[];
  /** Transform channels the export leaves to the host code (`timeline.setChannelExcluded`). */
  readonly excludedChannels: readonly TransformChannel[];
  /** Timeline Values the export leaves to the host code (`timeline.setValueExcluded`). */
  readonly excludedValues: readonly string[];
}

export interface EmitterView extends AnimatedView {
  readonly id: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly transform: TransformView;
  readonly events: readonly TimelineEvent[];
  /** The events play in the editor only; the export ships none (`timeline.setEventsExcluded`). */
  readonly eventsExcluded: boolean;
  /** What it spawns at every death of another emitter's particles (`timeline.addBurstOnDeath`). */
  readonly reactions: readonly DeathReaction[];
  /** Whether the emitter draws a trail - its `"trail"` graph exists (`scene.setTrail`). */
  readonly trail: boolean;
}

export interface MeshView extends AnimatedView {
  readonly id: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly transform: TransformView;
}

export interface SceneView {
  /** The project name (the exported class's name); set with `project.setName`. */
  readonly name: string;
  readonly timeline: { readonly duration: number; readonly fps: number; readonly loop: boolean };
  readonly vfx: {
    readonly id: string;
    readonly transform: TransformView;
    readonly transformTracks: readonly TransformTrackView[];
  };
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
  /**
   * Render graph only: whether the surface is lit, which it is exactly when a lighting node feeds
   * it (there is no lit/unlit switch). `undefined` on a behavior graph, or on a render graph too
   * broken to read.
   */
  readonly lit: boolean | undefined;
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
  /**
   * Problems that do not stop the graph from running here: past the Baseline tier's GPU limits,
   * or a VFX mesh its transform does not move. Present on a valid graph too.
   */
  readonly warnings: readonly string[];
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly nodeId?: string;
    readonly socketKey?: string;
    readonly slot?: string;
  }[];
}

/**
 * The compile status of an owner's graphs. Which graphs there are depends on the owner: an emitter
 * has a render and a behavior graph (and a trail one when it has a trail), a VFX mesh only the
 * render one - its `behavior` is `undefined`, so check before reading it.
 */
export interface StatusView {
  readonly ownerId: string | undefined;
  readonly render: GraphStatusView | undefined;
  /** The behavior graph's status; `undefined` for a VFX mesh, which has none. */
  readonly behavior: GraphStatusView | undefined;
  /** The trail graph's status; `undefined` without a trail. */
  readonly trail: GraphStatusView | undefined;
}

export function transformView(transform: Transform): TransformView {
  return {
    position: transform.position,
    rotation: quatToEuler(transform.rotation),
    scale: transform.scale,
  };
}

function transformTracksView(tracks: readonly TransformTrack[]): readonly TransformTrackView[] {
  return tracks.map((track) => ({
    channel: track.channel,
    keys: track.keys.map((key) => ({
      id: key.id,
      time: key.time,
      value: track.channel === "rotation" ? quatToEuler(key.value as Quat) : (key.value as Vec3),
      ...(key.ease !== undefined ? { ease: key.ease } : {}),
    })),
  }));
}

function animatedView(owner: {
  readonly transformTracks: readonly TransformTrack[];
  readonly tracks: readonly AnimationTrack[];
  readonly liveChannels: readonly TransformChannel[];
  readonly liveParams: readonly string[];
}): AnimatedView {
  return {
    transformTracks: transformTracksView(owner.transformTracks),
    tracks: owner.tracks,
    excludedChannels: owner.liveChannels,
    excludedValues: owner.liveParams,
  };
}

export function sceneView(source: SourceState): SceneView {
  const scene = source.scene;
  return structuredClone({
    name: source.name,
    timeline: {
      duration: source.timeline.duration,
      fps: source.timeline.fps,
      loop: source.timeline.loop,
    },
    vfx: {
      id: scene.vfx.id,
      transform: transformView(scene.vfx.transform),
      transformTracks: transformTracksView(scene.vfx.transformTracks),
    },
    emitters: scene.emitters.map((emitter) => ({
      id: emitter.id,
      name: emitter.name,
      hidden: emitter.hidden === true,
      transform: transformView(emitter.transform),
      events: emitter.events,
      eventsExcluded: emitter.liveEvents === true,
      reactions: emitter.reactions,
      trail: emitter.trailGraph !== undefined,
      ...animatedView(emitter),
    })),
    meshes: scene.meshes.map((mesh) => ({
      id: mesh.id,
      name: mesh.name,
      hidden: mesh.hidden === true,
      transform: transformView(mesh.transform),
      ...animatedView(mesh),
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
  const lighting = target.name === "render" ? renderGraphLighting(authored) : undefined;
  return structuredClone({
    ownerId: target.owner.id,
    graph: target.name,
    lit: lighting === undefined ? undefined : lighting.length > 0,
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
    warnings: status.warnings ?? [],
    errors: (status.errors ?? []).map((error) => ({
      code: error.code,
      message: error.message,
      ...(error.nodeId !== undefined ? { nodeId: error.nodeId } : {}),
      ...(error.socketKey !== undefined ? { socketKey: error.socketKey } : {}),
      ...(error.slot !== undefined ? { slot: error.slot } : {}),
    })),
  });
}
