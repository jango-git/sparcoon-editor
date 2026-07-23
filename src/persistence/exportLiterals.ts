/**
 * Pure TypeScript source-text formatting for the project export: given already-compiled IR and
 * plain document data, renders the literals/interfaces/class body that make up the emitted module.
 * No engine/compiler dependency - every function here takes data in and returns a string.
 */

import type {
  AnimationTrack,
  EmitterDoc,
  SourceState,
  TimelineEvent,
  VfxMeshDoc,
} from "../model/editorState";
import {
  TRANSFORM_CHANNELS,
  type Transform,
  type TransformChannel,
  type TransformTrack,
} from "../model/transform";
import type { EmitterIR, MeshIR } from "./exportCompile";

export function transformLiteral(transform: Transform): string {
  return JSON.stringify({
    position: transform.position,
    rotation: transform.rotation,
    scale: transform.scale,
  });
}

/** A track's keys as an exportable literal, dropped for any channel in `liveChannels` - that
 *  channel is left for the exported effect's live-update API (`getEmitter`/`getMesh`) instead. */
export function transformTracksLiteral(
  tracks: readonly TransformTrack[],
  liveChannels: readonly TransformChannel[],
): string {
  return JSON.stringify(
    tracks
      .filter((track) => !liveChannels.includes(track.channel))
      .map((track) => ({
        channel: track.channel,
        keys: track.keys.map((key) => ({ time: key.time, value: key.value })),
      })),
  );
}

/** See {@link transformTracksLiteral} - the same live-parameter exclusion for Timeline Value tracks. */
export function tracksLiteral(
  tracks: readonly AnimationTrack[],
  liveParams: readonly string[],
): string {
  return JSON.stringify(
    tracks
      .filter((track) => !liveParams.includes(track.name))
      .map((track) => ({
        name: track.name,
        keys: track.keys.map((key) => ({ time: key.time, value: key.value })),
      })),
  );
}

/** The shape `liveGetterOverride`/`liveParamSetterOverride`/`assertUniqueLiveNames` need;
 *  `EmitterDoc`/`VfxMeshDoc` satisfy it directly, so call sites just pass the doc. */
interface LiveEntity {
  readonly name: string;
  readonly liveChannels: readonly TransformChannel[];
  readonly liveParams: readonly string[];
}

/**
 * Sparcoon's name-keyed lookup assumes unique entity names; the editor doesn't enforce that, and a
 * duplicate would silently resolve to only the last-built entity at runtime (`FXEffect`'s
 * `Map.set` overwrites) while the generated types claim both are addressable. Fail loudly instead.
 */
export function assertUniqueLiveNames(entities: readonly LiveEntity[], kind: string): void {
  const seen = new Set<string>();
  for (const entity of entities) {
    if (entity.liveChannels.length === 0 && entity.liveParams.length === 0) {
      continue;
    }
    if (seen.has(entity.name)) {
      throw new Error(
        `exportTypeScript: two ${kind}s are both named ${JSON.stringify(entity.name)} and at ` +
          "least one has a fake (live) track - rename one so getEmitter/getMesh/setEmitterParam/" +
          "setMeshParam can address them unambiguously.",
      );
    }
    seen.add(entity.name);
  }
}

export function eventsLiteral(events: readonly TimelineEvent[]): string {
  return JSON.stringify(
    events.map((event) =>
      event.kind === "burst"
        ? { kind: "burst", time: event.time, count: event.count }
        : { kind: "play", time: event.time, rate: event.rate, duration: event.duration },
    ),
  );
}

/** The two names an entity's compiled render artifacts were bound to, keyed by tier -
 *  matches `FXRenderArtifactsByGLSLTier`'s shape once embedded in the spec literal. */
export interface RenderArtifactNames {
  readonly baseline: string;
  readonly standard: string;
}

export function emitterSpecLiteral(
  emitter: EmitterDoc,
  renderNames: RenderArtifactNames,
  behaviorName: string,
  ir: EmitterIR,
  slots: readonly string[],
  gpuKernelName?: string,
): string {
  return [
    "    {",
    `      name: ${JSON.stringify(emitter.name)},`,
    `      render: { baseline: ${renderNames.baseline}, standard: ${renderNames.standard} },`,
    `      behavior: ${behaviorName},`,
    // Present only when GPU simulation compiled (ir.gpuProgram); the JS `behavior` above is
    // always present, so an omitted gpuBehavior just means this emitter falls back to JS, as at runtime.
    ...(gpuKernelName !== undefined ? [`      gpuBehavior: ${gpuKernelName},`] : []),
    `      expectedCapacity: ${String(ir.expectedCapacity)},`,
    `      sortInterval: ${String(ir.sortInterval)},`,
    // Read from the surface sink (like sortInterval); emitted only when true, matching the
    // omit-when-false optional FXEffectEmitterSpec fields.
    ...(ir.castShadow ? ["      castShadow: true,"] : []),
    ...(ir.receiveShadow ? ["      receiveShadow: true,"] : []),
    `      externalSlots: ${JSON.stringify(slots)},`,
    `      transform: ${transformLiteral(emitter.transform)},`,
    `      transformTracks: ${transformTracksLiteral(emitter.transformTracks, emitter.liveChannels)},`,
    `      tracks: ${tracksLiteral(emitter.tracks, emitter.liveParams)},`,
    `      events: ${eventsLiteral(emitter.events)},`,
    `      liveChannels: ${JSON.stringify(emitter.liveChannels)},`,
    `      liveParams: ${JSON.stringify(emitter.liveParams)},`,
    "    }",
  ].join("\n");
}

export function meshSpecLiteral(
  mesh: VfxMeshDoc,
  renderNames: RenderArtifactNames,
  ir: MeshIR,
  slots: readonly string[],
): string {
  return [
    "    {",
    `      name: ${JSON.stringify(mesh.name)},`,
    `      render: { baseline: ${renderNames.baseline}, standard: ${renderNames.standard} },`,
    `      geometry: ${JSON.stringify(ir.geometry)},`,
    ...(ir.castShadow ? ["      castShadow: true,"] : []),
    ...(ir.receiveShadow ? ["      receiveShadow: true,"] : []),
    `      externalSlots: ${JSON.stringify(slots)},`,
    `      transform: ${transformLiteral(mesh.transform)},`,
    `      transformTracks: ${transformTracksLiteral(mesh.transformTracks, mesh.liveChannels)},`,
    `      tracks: ${tracksLiteral(mesh.tracks, mesh.liveParams)},`,
    `      liveChannels: ${JSON.stringify(mesh.liveChannels)},`,
    `      liveParams: ${JSON.stringify(mesh.liveParams)},`,
    "    }",
  ].join("\n");
}

export function projectSpecLiteral(
  source: SourceState,
  emitterSpecs: readonly string[],
  meshSpecs: readonly string[],
): string {
  const emitters = emitterSpecs.length === 0 ? "[]" : `[\n${emitterSpecs.join(",\n")},\n  ]`;
  const meshes = meshSpecs.length === 0 ? "[]" : `[\n${meshSpecs.join(",\n")},\n  ]`;
  return [
    "const SPEC: FXEffectSpec = {",
    `  duration: ${String(source.timeline.duration)},`,
    `  fps: ${String(source.timeline.fps)},`,
    `  transform: ${transformLiteral(source.scene.vfx.transform)},`,
    // The VFX group's transform is unconditionally live (see VfxDoc's doc) - every channel, always,
    // enforced right here rather than by anything upstream having remembered to mark it so.
    `  transformTracks: ${transformTracksLiteral(source.scene.vfx.transformTracks, TRANSFORM_CHANNELS)},`,
    `  emitters: ${emitters},`,
    `  meshes: ${meshes},`,
    "};",
  ].join("\n");
}

export function importLine(
  specifier: string,
  helperNames: readonly string[],
  needsEmitterType: boolean,
  needsGpuKernelType = false,
): string {
  const values = ["FXEffect", ...helperNames];
  const lines = [
    "import {",
    ...values.map((name) => `  ${name},`),
    "  type FXEffectOptions,",
    "  type FXEffectSpec,",
    "  type FXRenderArtifact,",
    "  type FXBehaviorArtifact,",
    ...(needsGpuKernelType ? ["  type FXParticleKernelArtifact,"] : []),
    ...(needsEmitterType ? ["  type FXEmitter,"] : []),
    `} from ${JSON.stringify(specifier)};`,
  ];
  return lines.join("\n");
}

/** The `<Name>Assets` constructor-parameter interface: one entry per external slot, a single flat
 *  namespace shared by textures and mesh geometries (ADR-0002), not a nested shape. */
export function assetsInterface(
  className: string,
  textureNames: readonly string[],
  geometryNames: readonly string[],
): string {
  const collision = geometryNames.find((name) => textureNames.includes(name));
  if (collision !== undefined) {
    throw new Error(
      `exportTypeScript: "${collision}" names both a Texture-node parameter and a custom mesh-asset ` +
        "geometry source - rename one so the exported Assets interface has one entry per name.",
    );
  }
  if (textureNames.length === 0 && geometryNames.length === 0) {
    return `export type ${className}Assets = Record<string, never>;`;
  }
  const fields = [
    ...textureNames.map((name) => `  ${name}: Texture;`),
    ...geometryNames.map((name) => `  ${name}: BufferGeometry;`),
  ].join("\n");
  return `export interface ${className}Assets {\n${fields}\n}`;
}

/** A quoted, `|`-joined TS union-literal type from `names` (only called with a non-empty list). */
function nameUnion(names: readonly string[]): string {
  return names.map((name) => JSON.stringify(name)).join(" | ");
}

/** Overrides `methodName` with one overload narrowing `name` to entities that declare a live
 *  channel - no wide-string fallback, so an unknown name is a compile error, not a silent no-op. */
function liveGetterOverride(
  methodName: string,
  returnType: string,
  entities: readonly LiveEntity[],
): readonly string[] {
  const names = entities
    .filter((entity) => entity.liveChannels.length > 0)
    .map((entity) => entity.name);
  if (names.length === 0) {
    return [];
  }
  return [
    `  public override ${methodName}(name: ${nameUnion(names)}): ${returnType};`,
    `  public override ${methodName}(name: string): ${returnType} {`,
    `    return super.${methodName}(name);`,
    "  }",
  ];
}

/** Overrides `methodName` with one overload per entity that declares a live parameter, narrowing both
 *  `name` and `parameter` literals - see {@link liveGetterOverride} for why there is no string fallback. */
function liveParamSetterOverride(
  methodName: string,
  entities: readonly LiveEntity[],
): readonly string[] {
  const live = entities.filter((entity) => entity.liveParams.length > 0);
  if (live.length === 0) {
    return [];
  }
  const lines: string[] = [];
  for (const entity of live) {
    lines.push(
      `  public override ${methodName}(name: ${JSON.stringify(entity.name)}, parameter: ` +
        `${nameUnion(entity.liveParams)}, value: number | readonly number[]): void;`,
    );
  }
  lines.push(
    `  public override ${methodName}(name: string, parameter: string, value: number | readonly number[]): void {`,
    `    super.${methodName}(name, parameter, value);`,
    "  }",
  );
  return lines;
}

export function classDeclaration(
  className: string,
  emitters: readonly LiveEntity[],
  meshes: readonly LiveEntity[],
): string {
  return [
    `export class ${className} extends FXEffect {`,
    ...liveGetterOverride("getEmitter", "FXEmitter | undefined", emitters),
    ...liveGetterOverride("getMesh", "Mesh | undefined", meshes),
    ...liveParamSetterOverride("setEmitterParam", emitters),
    ...liveParamSetterOverride("setMeshParam", meshes),
    `  public constructor(assets: ${className}Assets, options?: FXEffectOptions) {`,
    "    super(SPEC, assets, options);",
    "  }",
    "}",
  ].join("\n");
}

// Identifiers a PascalCased project name could collide with in module scope: "FXEmitter"/"Mesh" are
// imported only conditionally (a live channel), "Texture" unconditionally - reserving all three
// regardless is cheap and keeps this list independent of which project triggers which import.
const RESERVED_NAMES = new Set([
  "FXEffect",
  "FXEffectOptions",
  "FXEffectSpec",
  "SPEC",
  "Texture",
  "FXEmitter",
  "Mesh",
]);

/** A valid PascalCase class identifier from the project name; never collides with a module identifier. */
export function classNameFor(name: string): string {
  const pascal = name
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  const identifier = /^[A-Za-z]/.test(pascal) ? pascal : `Effect${pascal}`;
  const cleaned = identifier.length === 0 ? "Effect" : identifier;
  return RESERVED_NAMES.has(cleaned) ? `${cleaned}Export` : cleaned;
}
