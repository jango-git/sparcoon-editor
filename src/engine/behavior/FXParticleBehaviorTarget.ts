import type { FXValueType } from "../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../core/socket/FXValueType";
import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import { canonicalAttributeSuffix } from "../core/socket/FXAttribute";
import type { FXKernelBufferLayout, FXKernelIntegration } from "./FXCompiledKernel";
import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_CORE_LIFECYCLE_STRIDE,
  FX_CORE_POSITION,
  FX_CORE_POSITION_STRIDE,
  FX_ID,
  FX_LIFETIME,
  FX_POSITION_X,
  FX_POSITION_Y,
  FX_POSITION_Z,
} from "sparcoon";

/**
 * A builtin a behavior node may read. `offsets` are the float indices within the named
 * `buffer` (1 for a scalar, N for a vector); a synthesized input not backed by a buffer
 * (e.g. `dt`) omits them and is resolved by the kernel context specially.
 */
export interface FXKernelTargetInput {
  readonly name: string;
  readonly type: FXValueType;
  readonly offsets?: readonly number[];
  /** State buffer the offsets index; defaults to `"builtin"` - a custom target should always
   *  name its buffer explicitly. */
  readonly buffer?: string;
}

/**
 * A state slot a behavior node may write, and the float offset(s) it occupies within the
 * named `buffer`. Offsets are self-describing so validation can detect two slots writing the
 * same storage, and the kernel builder can emit writes without a separate offset table.
 */
export interface FXKernelTargetOutput {
  readonly slot: string;
  readonly type: FXValueType;
  readonly required: boolean;
  readonly offsets: readonly number[];
  /** State buffer the offsets index; defaults to `"builtin"` - a custom target should always
   *  name its buffer explicitly. */
  readonly buffer?: string;
}

/**
 * Contract between one phase of a behavior graph and the CPU kernel - the phase-based analog
 * of a render `FXTarget`. A behavior graph is authored once but compiled against *two* of
 * these, one per phase; the compiler routes each node to its phase target by its declared
 * phase. Described as data (not code) so a host can define its own target without touching
 * the kernel context/builder. `integration` (structured epilogue writes) is unused by the
 * default particle targets - motion is now an explicit `integrate-motion` graph node - but
 * stays available for a custom target.
 */
export interface FXKernelTarget {
  readonly name: string;
  /** State buffers this target exposes (name + per-particle float stride). */
  readonly buffers: readonly FXKernelBufferLayout[];
  readonly inputs: readonly FXKernelTargetInput[];
  readonly outputs: readonly FXKernelTargetOutput[];
  readonly preamble?: readonly string[];
  readonly integration?: readonly FXKernelIntegration[];
}

/**
 * The phase targets a behavior graph compiles against. `update` is always present; `spawn`
 * is optional - a particle pipeline supplies both, but a non-particle host may drive only an
 * update phase. When `spawn` is absent the compiler emits no spawn kernel.
 */
export interface FXBehaviorTargets {
  readonly spawn?: FXKernelTarget;
  readonly update: FXKernelTarget;
  /** Whether the orchestration layer (FXCompiledBehaviorBundle.ts) should also attempt any
   *  optional simulation family. Opaque data at this layer - the target shape itself does not
   *  know what a "family" is, it only carries the bit so the structural hash can fold it in. */
  readonly tryGpuSimulation?: boolean;
}

/**
 * Builds the phase targets for a set of requested attributes. Injected into the live compile
 * backend so the particle default ({@link buildParticleBehaviorTargets}) can be swapped for a
 * host's own target scheme.
 */
export type FXBehaviorTargetFactory = (
  attributes: readonly FXAttributeRequest[],
) => FXBehaviorTargets;

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;
const MAT4 = FX_VALUE_TYPES.mat4;
const INT = FX_VALUE_TYPES.int;

/**
 * The emitter's world (model) matrix, readable in both phases as `modelMatrix` - the same name
 * the render backend exposes, so one shared `world-matrix` node reads it on either side. A
 * synthesized input with no backing buffer (like `dt`); resolves to a field of the runtime
 * `emitter` argument (see `resolveKernelTargetInputRef`).
 */
export const FX_MODEL_MATRIX_INPUT = "modelMatrix";

/**
 * The emitter's world-space linear/angular velocity, readable in both phases via the same
 * synthesized-input mechanism as {@link FX_MODEL_MATRIX_INPUT}. Never derived from
 * `PARTICLE_POSITION` (emitter-local) - a graph combining them with local math must convert
 * spaces itself.
 */
export const FX_OBJECT_VELOCITY_INPUT = "objectVelocity";
export const FX_OBJECT_ANGULAR_VELOCITY_INPUT = "objectAngularVelocity";

/** Kernel-argument field each host-matrix/motion input resolves to (`emitter.<field>[component]`). */
export const FX_EMITTER_INPUT_FIELD: Readonly<
  Record<string, "worldMatrix" | "velocity" | "angularVelocity">
> = {
  [FX_MODEL_MATRIX_INPUT]: "worldMatrix",
  [FX_OBJECT_VELOCITY_INPUT]: "velocity",
  [FX_OBJECT_ANGULAR_VELOCITY_INPUT]: "angularVelocity",
};

const EMITTER_HOST_INPUTS: readonly FXKernelTargetInput[] = [
  { name: FX_MODEL_MATRIX_INPUT, type: MAT4 },
  { name: FX_OBJECT_VELOCITY_INPUT, type: VEC3 },
  { name: FX_OBJECT_ANGULAR_VELOCITY_INPUT, type: VEC3 },
];

/**
 * The current particle's own index into the state buffers (the JS loop variable `i`; the
 * standard-tier GLSL assembler synthesizes it as `gl_VertexID`). A synthesized input like
 * {@link FX_MODEL_MATRIX_INPUT}, but resolved and classified separately
 * (`resolveKernelTargetInputRef`/`isInvariantKernelRef`): unlike the emitter-transform inputs,
 * which are the same value for every particle in one tick, this one is different for every
 * particle and must never be loop-hoisted.
 */
export const FX_PARTICLE_INDEX_INPUT = "PARTICLE_INDEX";

const PARTICLE_INDEX_INPUTS: readonly FXKernelTargetInput[] = [
  { name: FX_PARTICLE_INDEX_INPUT, type: INT },
];

/** The two fixed core buffers: position vec3, lifecycle vec3 `[age, lifetime, id]`. */
const POSITION_BUFFER = FX_CORE_POSITION;
const LIFECYCLE_BUFFER = FX_CORE_LIFECYCLE;

/**
 * The core builtins a node may read: position and age/lifetime/id. Everything else that used to
 * be a builtin (velocity, scale, rotation, torque, per-particle randoms) is now an ordinary
 * user-declared attribute, read through the attribute channel instead.
 */
const scalarReadInputs: readonly FXKernelTargetInput[] = [
  { name: "PARTICLE_POSITION_X", type: FLOAT, offsets: [FX_POSITION_X], buffer: POSITION_BUFFER },
  { name: "PARTICLE_POSITION_Y", type: FLOAT, offsets: [FX_POSITION_Y], buffer: POSITION_BUFFER },
  { name: "PARTICLE_POSITION_Z", type: FLOAT, offsets: [FX_POSITION_Z], buffer: POSITION_BUFFER },
  { name: "PARTICLE_AGE", type: FLOAT, offsets: [FX_AGE], buffer: LIFECYCLE_BUFFER },
  { name: "PARTICLE_LIFETIME", type: FLOAT, offsets: [FX_LIFETIME], buffer: LIFECYCLE_BUFFER },
  { name: "PARTICLE_ID", type: FLOAT, offsets: [FX_ID], buffer: LIFECYCLE_BUFFER },
];

/** `PARTICLE_POSITION` readable as a single `vec3` (component-expanded by the kernel). */
const vec3ReadInputs: readonly FXKernelTargetInput[] = [
  {
    name: "PARTICLE_POSITION",
    type: VEC3,
    offsets: [FX_POSITION_X, FX_POSITION_Y, FX_POSITION_Z],
    buffer: POSITION_BUFFER,
  },
];

const readInputs: readonly FXKernelTargetInput[] = [...scalarReadInputs, ...vec3ReadInputs];

/** Scalar writable core slots; `lifetime` is birth-only. */
const scalarWriteSlots: readonly {
  slot: string;
  offset: number;
  buffer: string;
  spawnOnly: boolean;
}[] = [
  { slot: "positionX", offset: FX_POSITION_X, buffer: POSITION_BUFFER, spawnOnly: false },
  { slot: "positionY", offset: FX_POSITION_Y, buffer: POSITION_BUFFER, spawnOnly: false },
  { slot: "positionZ", offset: FX_POSITION_Z, buffer: POSITION_BUFFER, spawnOnly: false },
  { slot: "lifetime", offset: FX_LIFETIME, buffer: LIFECYCLE_BUFFER, spawnOnly: true },
];

/** Writable `vec3` core slot(s) (available in both phases). */
const vec3WriteSlots: readonly {
  slot: string;
  offsets: readonly [number, number, number];
  buffer: string;
}[] = [
  {
    slot: "position",
    offsets: [FX_POSITION_X, FX_POSITION_Y, FX_POSITION_Z],
    buffer: POSITION_BUFFER,
  },
];

/** Builds the writable-slot set for a phase; `includeSpawnOnly` adds `lifetime`. */
function writeOutputs(includeSpawnOnly: boolean): readonly FXKernelTargetOutput[] {
  const scalars = scalarWriteSlots
    .filter((entry) => includeSpawnOnly || !entry.spawnOnly)
    .map((entry): FXKernelTargetOutput => ({
      slot: entry.slot,
      type: FLOAT,
      required: false,
      offsets: [entry.offset],
      buffer: entry.buffer,
    }));
  const vec3s = vec3WriteSlots.map((entry): FXKernelTargetOutput => ({
    slot: entry.slot,
    type: VEC3,
    required: false,
    offsets: entry.offsets,
    buffer: entry.buffer,
  }));
  return [...scalars, ...vec3s];
}

/** The two fixed core buffers, always present in a particle target. */
const CORE_BUFFERS: readonly FXKernelBufferLayout[] = [
  { name: POSITION_BUFFER, stride: FX_CORE_POSITION_STRIDE },
  { name: LIFECYCLE_BUFFER, stride: FX_CORE_LIFECYCLE_STRIDE },
];

/** Behavior target-input name exposing an attribute buffer for reads (both phases). */
export function attributeInputName(name: string): string {
  return `ATTR_${name}`;
}

/** Behavior output-slot name a `store-attribute` node binds to write an attribute. */
export function attributeSlot(name: string): string {
  return `attr:${name}`;
}

/** `attributeSlot`'s prefix, derived (not re-typed) so a format change can't drift the two apart. */
const ATTRIBUTE_SLOT_PREFIX = attributeSlot("");

/**
 * The inverse of {@link attributeSlot}: the declared attribute name a slot writes, or `undefined`
 * for a builtin slot (`position`/`velocity`/...) that isn't an `attr:<name>` write.
 */
export function attributeNameFromSlot(slotKey: string): string | undefined {
  return slotKey.startsWith(ATTRIBUTE_SLOT_PREFIX)
    ? slotKey.slice(ATTRIBUTE_SLOT_PREFIX.length)
    : undefined;
}

/** `[0, 1, ..., components-1]` - the in-buffer offsets of an attribute's components. */
function attributeOffsets(components: number): number[] {
  return [...Array(components).keys()];
}

/** Attribute buffer + input + slot fragments shared by both phases. */
function attributeBuffers(
  attributes: readonly FXAttributeRequest[],
): readonly FXKernelBufferLayout[] {
  return attributes.map((attribute) => ({
    name: attribute.name,
    stride: attribute.type.components,
  }));
}

function attributeInputs(
  attributes: readonly FXAttributeRequest[],
): readonly FXKernelTargetInput[] {
  return attributes.map((attribute) => ({
    name: attributeInputName(attribute.name),
    type: attribute.type,
    buffer: attribute.name,
    offsets: attributeOffsets(attribute.type.components),
  }));
}

function attributeSlots(
  attributes: readonly FXAttributeRequest[],
): readonly FXKernelTargetOutput[] {
  return attributes.map((attribute) => ({
    slot: attributeSlot(attribute.name),
    type: attribute.type,
    required: false,
    buffer: attribute.name,
    offsets: attributeOffsets(attribute.type.components),
  }));
}

/**
 * Builds the spawn/update phase targets for a particle behavior graph, extended with a
 * per-particle buffer/input/slot for each requested attribute. The attribute set is folded
 * into the target name so it participates in the structural hash.
 */
export function buildParticleBehaviorTargets(
  attributes: readonly FXAttributeRequest[] = [],
  tryGpuSimulation = false,
): { spawn: FXKernelTarget; update: FXKernelTarget; tryGpuSimulation: boolean } {
  const suffix = canonicalAttributeSuffix(attributes);
  const buffers: readonly FXKernelBufferLayout[] = [
    ...CORE_BUFFERS,
    ...attributeBuffers(attributes),
  ];
  const attributeInputEntries = attributeInputs(attributes);
  const attributeSlotEntries = attributeSlots(attributes);

  const spawn: FXKernelTarget = {
    name: `particle-behavior-spawn${suffix}`,
    buffers,
    inputs: [
      ...readInputs,
      ...EMITTER_HOST_INPUTS,
      ...PARTICLE_INDEX_INPUTS,
      ...attributeInputEntries,
    ],
    outputs: [...writeOutputs(true), ...attributeSlotEntries],
  };
  const update: FXKernelTarget = {
    name: `particle-behavior-update${suffix}`,
    buffers,
    inputs: [
      ...readInputs,
      { name: "dt", type: FLOAT },
      ...EMITTER_HOST_INPUTS,
      ...PARTICLE_INDEX_INPUTS,
      ...attributeInputEntries,
    ],
    outputs: [...writeOutputs(false), ...attributeSlotEntries],
    // No built-in integration: motion is an explicit `integrate-motion` node now.
  };
  return { spawn, update, tryGpuSimulation };
}
