/**
 * Pure TypeScript source-text formatting for the project export: given already-compiled IR and
 * plain document data, renders the literals/interfaces/class body that make up the emitted module.
 * No engine/compiler dependency - every function here takes data in and returns a string.
 */

import { FX_RUNTIME_VERSION } from "sparcoon/editor";

import {
  FX_ASSET_KIND_LIST,
  FX_ASSET_KINDS,
  type FXAssetKind,
} from "../engine/core/nodes/FXAssetKind";
import {
  type AnimationTrack,
  emissionBasisField,
  type EmitterDoc,
  type Keyframe,
  type Reaction,
  type SourceState,
  type SpawnAction,
  type TimelineEvent,
  type VfxMeshDoc,
} from "../model/editorState";
import { STRIP_NAMES, type StripName } from "../model/graphSlots";
import {
  type Transform,
  TRANSFORM_CHANNELS,
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

/** One key as the runtime reads it: no editor id; a curve only when it has one (linear has none). */
function keyLiteral(key: Keyframe): Pick<Keyframe, "time" | "value" | "ease"> {
  return {
    time: key.time,
    value: key.value,
    ...(key.ease !== undefined ? { ease: key.ease } : {}),
  };
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
        keys: track.keys.map(keyLiteral),
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
        keys: track.keys.map(keyLiteral),
      })),
  );
}

/** The fields the live-name helpers read from an emitter or mesh doc. */
interface LiveEntity {
  readonly name: string;
  readonly liveChannels: readonly TransformChannel[];
  readonly liveParams: readonly string[];
  /** Emitters only - see `EmitterDoc.liveEvents`. */
  readonly liveEvents?: true;
}

/**
 * Whether the host code reaches `entity` by name through `getEmitter`/`getMesh`: to pose a live
 * channel, or to spawn the particles its live events leave to it.
 */
export function needsLiveGetter(entity: LiveEntity): boolean {
  return entity.liveChannels.length > 0 || entity.liveEvents === true;
}

/**
 * Sparcoon's name-keyed lookup assumes unique entity names; the editor doesn't enforce that, and a
 * duplicate would silently resolve to only the last-built entity at runtime (`FXEffect`'s
 * `Map.set` overwrites) while the generated types claim both are addressable. Fail loudly instead.
 */
export function assertUniqueLiveNames(entities: readonly LiveEntity[], kind: string): void {
  const named = new Set<string>();
  const clashing = new Set<string>();
  for (const entity of entities) {
    (named.has(entity.name) ? clashing : named).add(entity.name);
  }
  // Every same-named entity counts: one live among them is enough for a lookup to land on another.
  const addressed = entities.find(
    (entity) =>
      clashing.has(entity.name) && (needsLiveGetter(entity) || entity.liveParams.length > 0),
  );
  if (addressed !== undefined) {
    throw new Error(
      `exportTypeScript: two ${kind}s are both named ${JSON.stringify(addressed.name)} and at ` +
        "least one has a fake (live) track or live events - rename one so getEmitter/getMesh/" +
        "setEmitterParam/setMeshParam can address them unambiguously.",
    );
  }
}

/** A spawn action as the runtime's `FXSpawnAction` reads it - only the fields its kind carries. */
function actionLiteral(action: SpawnAction): SpawnAction {
  return action.kind === "burst"
    ? { kind: "burst", count: action.count }
    : {
        kind: "play",
        rate: action.rate,
        duration: action.duration,
        ...emissionBasisField(action.over ?? "time"),
      };
}

/** The spawn events as the runtime reads them; none when `liveEvents` leaves spawning to the host. */
export function eventsLiteral(events: readonly TimelineEvent[], liveEvents?: true): string {
  if (liveEvents === true) {
    return "[]";
  }
  return JSON.stringify(events.map((event) => ({ ...actionLiteral(event), time: event.time })));
}

/**
 * The reactions as the runtime reads them, each source by its index in the exported emitter list
 * (`emitterIndex`, by emitter id) - the export keeps every emitter, in scene order - with the
 * particle event it fires on (omitted for a death, the runtime's default) and what its births
 * inherit of the source's particle (`copiesOf`, see `reactionLinking.ts`, omitted when nothing).
 */
export function reactionsLiteral(
  reactions: readonly Reaction[],
  emitterIndex: ReadonlyMap<string, number>,
  copiesOf: (reaction: Reaction) => readonly number[],
): string {
  return JSON.stringify(
    reactions.map((reaction) => {
      const source = emitterIndex.get(reaction.source);
      if (source === undefined) {
        throw new Error(
          `exportTypeScript: a reaction's source "${reaction.source}" is not exported`,
        );
      }
      const copies = copiesOf(reaction);
      return {
        ...actionLiteral(reaction),
        source,
        ...(reaction.on === "death" ? {} : { on: reaction.on }),
        ...(copies.length > 0 ? { copies } : {}),
      };
    }),
  );
}

/** The two names an entity's compiled render artifacts were bound to, keyed by tier -
 *  matches `FXRenderArtifactsByGLSLTier`'s shape once embedded in the spec literal. */
export interface RenderArtifactNames {
  readonly baseline: string;
  readonly standard: string;
}

/** The constants an emitter's render artifacts were written to: its particles' (absent when they
 *  are not drawn), and its trail's and ribbon's when it has them. */
export type EmitterArtifactNames = {
  readonly [K in "render" | StripName]?: RenderArtifactNames;
};

/** A strip's spec: its artifacts by tier, and the option fields its sink gave, as literals. */
function stripLiteral(names: RenderArtifactNames, fields: object): string {
  const entries = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `{ ${[`render: ${byTier(names)}`, ...entries].join(", ")} }`;
}

/** `{ baseline, standard }` of `names`, as `FXRenderArtifactsByGLSLTier`. */
function byTier(names: RenderArtifactNames): string {
  return `{ baseline: ${names.baseline}, standard: ${names.standard} }`;
}

export function emitterSpecLiteral(
  emitter: EmitterDoc,
  names: EmitterArtifactNames,
  behaviorName: string,
  ir: EmitterIR,
  slots: readonly string[],
  emitterIndex: ReadonlyMap<string, number>,
  copiesOf: (reaction: Reaction) => readonly number[],
  gpuKernelName?: string,
): string {
  // The names are the constants each artifact was written to - one without the other is a caller
  // bug, never an emitter to export without its particles or a strip.
  for (const [what, has, named] of [
    ["render", ir.drawParticles, names.render] as const,
    ...STRIP_NAMES.map((name) => [name, ir[name] !== undefined, names[name]] as const),
  ]) {
    if (has !== (named !== undefined)) {
      throw new Error(
        `exportTypeScript: ${emitter.name}: ${what} artifact names must be given exactly when ` +
          `the emitter draws one`,
      );
    }
  }
  return [
    "    {",
    `      name: ${JSON.stringify(emitter.name)},`,
    ...(names.render === undefined ? [] : [`      render: ${byTier(names.render)},`]),
    `      behavior: ${behaviorName},`,
    // Present only when GPU simulation compiled (ir.gpuProgram); the JS `behavior` above is
    // always present, so an omitted gpuBehavior just means this emitter falls back to JS, as at runtime.
    ...(gpuKernelName !== undefined ? [`      gpuBehavior: ${gpuKernelName},`] : []),
    `      expectedCapacity: ${String(ir.expectedCapacity)},`,
    ...(ir.maxLifetime !== undefined ? [`      maxLifetime: ${String(ir.maxLifetime)},`] : []),
    `      sortInterval: ${String(ir.sortInterval)},`,
    // Read from the surface sink (like sortInterval); emitted only when true, matching the
    // omit-when-false optional FXEffectEmitterSpec fields.
    ...(ir.castShadow ? ["      castShadow: true,"] : []),
    ...(ir.receiveShadow ? ["      receiveShadow: true,"] : []),
    ...STRIP_NAMES.flatMap((name) => {
      const strip = ir[name];
      const stripNames = names[name];
      return strip === undefined || stripNames === undefined
        ? []
        : [`      ${name}: ${stripLiteral(stripNames, strip.fields)},`];
    }),
    `      externalSlots: ${JSON.stringify(slots)},`,
    `      transform: ${transformLiteral(emitter.transform)},`,
    `      transformTracks: ${transformTracksLiteral(emitter.transformTracks, emitter.liveChannels)},`,
    `      tracks: ${tracksLiteral(emitter.tracks, emitter.liveParams)},`,
    `      events: ${eventsLiteral(emitter.events, emitter.liveEvents)},`,
    ...(emitter.reactions.length > 0
      ? [`      reactions: ${reactionsLiteral(emitter.reactions, emitterIndex, copiesOf)},`]
      : []),
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
    `      render: ${byTier(renderNames)},`,
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
    // The runtime this module is compiled against: FXEffect warns when it is played on one that
    // does not satisfy it.
    `  runtime: ${JSON.stringify(FX_RUNTIME_VERSION)},`,
    `  duration: ${String(source.timeline.duration)},`,
    `  fps: ${String(source.timeline.fps)},`,
    `  loop: ${String(source.timeline.loop)},`,
    `  transform: ${transformLiteral(source.scene.vfx.transform)},`,
    // The VFX group's transform is always live: every channel is excluded from the export.
    `  transformTracks: ${transformTracksLiteral(source.scene.vfx.transformTracks, TRANSFORM_CHANNELS)},`,
    `  emitters: ${emitters},`,
    `  meshes: ${meshes},`,
    "};",
  ].join("\n");
}

export function importLine(
  specifier: string,
  needsEmitterType: boolean,
  needsGpuKernelType = false,
  needsExternalTextureType = false,
): string {
  const lines = [
    "import {",
    "  FXEffect,",
    "  type FXEffectOptions,",
    "  type FXEffectSpec,",
    "  type FXRenderArtifact,",
    "  type FXBehaviorArtifact,",
    ...(needsGpuKernelType ? ["  type FXParticleKernelArtifact,"] : []),
    ...(needsEmitterType ? ["  type FXEmitter,"] : []),
    ...(needsExternalTextureType ? ["  type FXExternalTexture,"] : []),
    `} from ${JSON.stringify(specifier)};`,
  ];
  return lines.join("\n");
}

/** The names of an exported effect's external assets, by what the app supplies for each: Texture
 *  node parameters as an `FXExternalTexture`, the assets of each kind as that kind asks for them
 *  (`FX_ASSET_KINDS`), a custom geometry among the meshes. */
export type ExternalAssetNames = Readonly<Record<"textures" | FXAssetKind, readonly string[]>>;

const EXTERNAL_LISTS: readonly (keyof ExternalAssetNames)[] = ["textures", ...FX_ASSET_KIND_LIST];

/** The type the app supplies an asset of `list` as. */
function externalTypeOf(list: keyof ExternalAssetNames): string {
  return list === "textures" ? "FXExternalTexture" : FX_ASSET_KINDS[list].appType;
}

/** `names` with a mesh of the scene left out of the meshes read as a shape: the runtime takes a
 *  `Mesh`'s geometry as the geometry of its name, so the effect asks for the mesh once. */
function askedNames(names: ExternalAssetNames): ExternalAssetNames {
  const objects = new Set([...names.sceneMesh, ...names.skinnedMesh]);
  return { ...names, mesh: names.mesh.filter((name) => !objects.has(name)) };
}

/** The three types the app supplies `names` as, to import as types. */
export function threeAssetTypes(names: ExternalAssetNames): readonly string[] {
  const asked = askedNames(names);
  return [
    ...new Set(FX_ASSET_KIND_LIST.filter((kind) => asked[kind].length > 0).map(externalTypeOf)),
  ];
}

/** The `<Name>Assets` constructor-parameter interface. One entry per external asset, in a single
 *  flat namespace shared by every kind. A texture slot takes `FXExternalTexture` (a `Texture`, or
 *  an atlas region of one). A mesh of the scene is asked for once, as a `Mesh` or `SkinnedMesh`,
 *  where an effect also draws or samples its geometry as a shape. */
export function assetsInterface(className: string, allNames: ExternalAssetNames): string {
  const names = askedNames(allNames);
  const owners = new Map<string, keyof ExternalAssetNames>();
  for (const list of EXTERNAL_LISTS) {
    for (const name of names[list]) {
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new Error(
          `exportTypeScript: "${name}" names both one of the ${owner} and one of the ${list} - ` +
            "rename one so the exported Assets interface has one entry per name.",
        );
      }
      owners.set(name, list);
    }
  }
  if (owners.size === 0) {
    return `export type ${className}Assets = Record<string, never>;`;
  }
  const fields = EXTERNAL_LISTS.flatMap((list) =>
    names[list].map((name) => `  ${propertyKey(name)}: ${externalTypeOf(list)};`),
  ).join("\n");
  return `export interface ${className}Assets {\n${fields}\n}`;
}

/** `name` as a property key: bare when it is an identifier, quoted otherwise - a mesh asset keeps
 *  its GLB mesh or file name, such as `rock.glb #1`. */
function propertyKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

/** A quoted, `|`-joined TS union-literal type from `names` (only called with a non-empty list). */
function nameUnion(names: readonly string[]): string {
  return names.map((name) => JSON.stringify(name)).join(" | ");
}

/** Overrides `methodName` with one overload narrowing `name` to the entities the host reaches
 *  ({@link needsLiveGetter}) - no wide-string fallback, so an unknown name is a compile error, not a
 *  silent no-op. */
function liveGetterOverride(
  methodName: string,
  returnType: string,
  entities: readonly LiveEntity[],
): readonly string[] {
  const names = entities.filter(needsLiveGetter).map((entity) => entity.name);
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

// Module-scope identifiers a PascalCased project name must not equal. The conditionally imported
// ones are reserved always, so the list does not depend on the project.
const RESERVED_NAMES = new Set([
  "FXEffect",
  "FXEffectOptions",
  "FXEffectSpec",
  "SPEC",
  "FXExternalTexture",
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
