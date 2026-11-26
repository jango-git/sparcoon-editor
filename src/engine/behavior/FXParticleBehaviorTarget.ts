import type { FXEmitterTransform } from "sparcoon";
import {
  FX_AGE,
  FX_CORE_BUFFERS,
  FX_CORE_LIFECYCLE,
  FX_CORE_POSITION,
  FX_ID,
  FX_LIFETIME,
  FX_POSITION_X,
  FX_POSITION_Y,
  FX_POSITION_Z,
} from "sparcoon";
import { packingOrder } from "sparcoon/editor";

import { collectAttributeRequests } from "../core/compiler/collectAttributeRequests";
import type { FXGraph } from "../core/FXGraph";
import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import { canonicalAttributeSuffix } from "../core/socket/FXAttribute";
import { FX_RANDOM_SEED_INPUT } from "../core/socket/FXReadableBuiltins";
import type { FXValueType } from "../core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../core/socket/FXValueType";
import type { FXBehaviorNode } from "./FXBehaviorNode";
import type { FXKernelBufferLayout, FXKernelIntegration } from "./FXCompiledKernel";
import { collectInheritRequests, planInherits } from "./FXInherit";
import type { FXInheritPlan, FXInheritRequest } from "./FXInheritPlan";
import { FX_KILL_SLOT } from "./FXKernelLifecycle.Internal";

export type FXEmitterTransformField = keyof FXEmitterTransform;

/** A parameter of the kernel function an input may read. Which phase takes which is the phase's
 *  parameter list (`SPAWN_KERNEL_PARAMETERS`, `UPDATE_KERNEL_PARAMETERS`). */
export type FXKernelHostParameter = "dt" | "seed";

/** A value the kernel gets from its caller rather than from the particle's slot. */
export type FXKernelHostValue =
  /** The same for every particle of a call. */
  | { readonly kind: "parameter"; readonly parameter: FXKernelHostParameter }
  /** The particle's own index into the slots, different for every particle. */
  | { readonly kind: "particleIndex" }
  | { readonly kind: "emitter"; readonly field: FXEmitterTransformField };

/**
 * A value a node may read. It comes from exactly one place: the particle's slot (`offsets`, the
 * float indices within `buffer`, one per component), what the newborns of a spawn call inherit
 * (`inheritOffset`) or the kernel's caller (`host`).
 */
export interface FXKernelTargetInput {
  readonly name: string;
  readonly type: FXValueType;
  readonly offsets?: readonly number[];
  /** State buffer the offsets index; defaults to `"builtin"` - a custom target should always
   *  name its buffer explicitly. */
  readonly buffer?: string;
  /**
   * The model matrix of a spawn target, read as it stood at each particle's birth rather than
   * once per call: a newborn is seeded `age` seconds old (born that long before its tick's end),
   * so it spawns from the emitter's translation moved back along the emitter's velocity by that
   * age - its rotation and scale are the call's. Different for every particle, so never hoisted
   * or lifted; needs the core `lifecycle` buffer, the age it reads.
   */
  readonly atBirth?: boolean;
  /**
   * Where in the target's {@link FXKernelTarget.inherit} layout this input's floats start: a value
   * the newborns of one spawn call share, inherited from the particle whose death spawned them.
   * Offset-less like the emitter transform, so hoisted; spawn targets only.
   */
  readonly inheritOffset?: number;
  readonly host?: FXKernelHostValue;
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
 * What one phase of a behavior graph may read and write. A graph compiles against two (spawn and
 * update), each node routed by its phase. Plain data, so a host can define its own. `integration`
 * (epilogue writes) is unused by the particle targets, where motion is an `integrate-motion` node.
 */
export interface FXKernelTarget {
  readonly name: string;
  /** State buffers this target exposes (name + per-particle float stride). */
  readonly buffers: readonly FXKernelBufferLayout[];
  readonly inputs: readonly FXKernelTargetInput[];
  readonly outputs: readonly FXKernelTargetOutput[];
  readonly preamble?: readonly string[];
  readonly integration?: readonly FXKernelIntegration[];
  /**
   * The slot that kills a particle early: a float, killing above `FX_KILL_THRESHOLD`. Not an
   * output - it writes no storage, the lifecycle epilogue applies it. Update targets only; needs
   * the core `lifecycle` buffer.
   */
  readonly killSlot?: string;
  /** What the newborns inherit, its values read by the inputs with an `inheritOffset`; absent
   *  when nothing. Spawn targets only. */
  readonly inherit?: FXInheritPlan;
  /**
   * A spawn target: its slot reads see the newborn's slot as the runtime hands it over - zero but
   * for the particle's birth age and id - not the state of the slot's previous particle.
   */
  readonly birth?: boolean;
}

/**
 * The phase targets a behavior graph compiles against. `update` is always present; `spawn`
 * is optional - a particle pipeline supplies both, but a non-particle host may drive only an
 * update phase. When `spawn` is absent the compiler emits no spawn kernel.
 */
export interface FXBehaviorTargets {
  readonly spawn?: FXKernelTarget;
  readonly update: FXKernelTarget;
  /**
   * Opts the target in to the optional simulation families (see FXCompiledBehaviorBundle). Only
   * folded into the structural hash here.
   */
  readonly tryGpuSimulation?: boolean;
}

export type FXBehaviorTargetFactory = (
  attributes: readonly FXAttributeRequest[],
  graph: FXGraph<FXBehaviorNode>,
) => FXBehaviorTargets;

const FLOAT = FX_VALUE_TYPES.float;
const VEC3 = FX_VALUE_TYPES.vec3;
const MAT4 = FX_VALUE_TYPES.mat4;
const INT = FX_VALUE_TYPES.int;

/**
 * The emitter's world (model) matrix, readable in both phases as `modelMatrix` - the same name
 * the render backend exposes, so one shared `world-matrix` node reads it on either side. In the
 * spawn phase it is read as it stood at each particle's birth (`FXKernelTargetInput.atBirth`).
 */
export const FX_MODEL_MATRIX_INPUT = "modelMatrix";

/**
 * The emitter's world-space linear/angular velocity, readable in both phases. Never derived from
 * `PARTICLE_POSITION`, which declares no space - a graph that keeps positions relative to the
 * emitter must convert this velocity itself.
 */
export const FX_OBJECT_VELOCITY_INPUT = "objectVelocity";
export const FX_OBJECT_ANGULAR_VELOCITY_INPUT = "objectAngularVelocity";

const EMITTER_HOST_INPUTS: readonly FXKernelTargetInput[] = [
  { name: FX_MODEL_MATRIX_INPUT, type: MAT4, host: { kind: "emitter", field: "worldMatrix" } },
  { name: FX_OBJECT_VELOCITY_INPUT, type: VEC3, host: { kind: "emitter", field: "velocity" } },
  {
    name: FX_OBJECT_ANGULAR_VELOCITY_INPUT,
    type: VEC3,
    host: { kind: "emitter", field: "angularVelocity" },
  },
];

/** Spawn-phase emitter inputs: the model matrix is read as at the particle birth. */
const SPAWN_EMITTER_HOST_INPUTS: readonly FXKernelTargetInput[] = EMITTER_HOST_INPUTS.map(
  (input) => (input.name === FX_MODEL_MATRIX_INPUT ? { ...input, atBirth: true } : input),
);

export const FX_DT_INPUT: FXKernelTargetInput = {
  name: "dt",
  type: FX_VALUE_TYPES.float,
  host: { kind: "parameter", parameter: "dt" },
};

/** The seed of the update a CPU kernel runs in, its `seed` parameter: what its random draws hash
 *  with the particle's id (see `FXKernelRandom.Internal.ts`). */
export const FX_SEED_INPUT: FXKernelTargetInput = {
  name: "SIMULATION_SEED",
  type: FX_VALUE_TYPES.int,
  host: { kind: "parameter", parameter: "seed" },
};

export const FX_PARTICLE_INDEX_INPUT = "PARTICLE_INDEX";

const PARTICLE_INDEX_INPUTS: readonly FXKernelTargetInput[] = [
  { name: FX_PARTICLE_INDEX_INPUT, type: INT, host: { kind: "particleIndex" } },
];

export const FX_PARTICLE_ID_INPUT = "PARTICLE_ID";

/** The two fixed core buffers: position vec3, lifecycle vec3 `[age, lifetime, id]`. */
const POSITION_BUFFER = FX_CORE_POSITION;
const LIFECYCLE_BUFFER = FX_CORE_LIFECYCLE;

/**
 * The core builtins a node may read: position and age/lifetime/id. Every other per-particle value
 * (velocity, scale, rotation, torque, per-particle randoms) is an ordinary user-declared attribute,
 * read through the attribute channel instead.
 */
const scalarReadInputs: readonly FXKernelTargetInput[] = [
  { name: "PARTICLE_POSITION_X", type: FLOAT, offsets: [FX_POSITION_X], buffer: POSITION_BUFFER },
  { name: "PARTICLE_POSITION_Y", type: FLOAT, offsets: [FX_POSITION_Y], buffer: POSITION_BUFFER },
  { name: "PARTICLE_POSITION_Z", type: FLOAT, offsets: [FX_POSITION_Z], buffer: POSITION_BUFFER },
  { name: "PARTICLE_AGE", type: FLOAT, offsets: [FX_AGE], buffer: LIFECYCLE_BUFFER },
  { name: "PARTICLE_LIFETIME", type: FLOAT, offsets: [FX_LIFETIME], buffer: LIFECYCLE_BUFFER },
  { name: FX_PARTICLE_ID_INPUT, type: FLOAT, offsets: [FX_ID], buffer: LIFECYCLE_BUFFER },
  // What a random seeds from by default: the particle's id, as on the render side.
  { name: FX_RANDOM_SEED_INPUT, type: FLOAT, offsets: [FX_ID], buffer: LIFECYCLE_BUFFER },
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

export function attributeInputName(name: string): string {
  return `ATTR_${name}`;
}

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

/**
 * The particle slot's buffers in the order both kernels lay it out - the JS one's literal offsets
 * and the GPU one's attribute locations follow it, and the runtime never reorders it: sparcoon's
 * {@link packingOrder}, so the fields it packs into one vertex attribute view lie side by side.
 * The runtime's own function, not a copy; set-based, so the order never depends on the order
 * attributes were declared in.
 */
function slotOrder(buffers: readonly FXKernelBufferLayout[]): readonly FXKernelBufferLayout[] {
  return packingOrder(
    buffers.map((buffer) => ({ name: buffer.name, components: buffer.stride, buffer })),
  ).map((field) => field.buffer);
}

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

/** One spawn input per value of an inherit plan, at its offset. */
function inheritInputs(plan: FXInheritPlan): readonly FXKernelTargetInput[] {
  return plan.entries.map((entry) => ({
    name: entry.inputName,
    type: entry.request.type,
    inheritOffset: entry.offset,
  }));
}

/**
 * Builds the spawn/update phase targets for a particle behavior graph, extended with a
 * per-particle buffer/input/slot for each requested attribute, and with a spawn input for each
 * value its newborns inherit. The attribute set is folded into the target names so it
 * participates in the structural hash; the inherit layout is part of the spawn target's shape.
 */
export function buildParticleBehaviorTargets(
  attributes: readonly FXAttributeRequest[] = [],
  tryGpuSimulation = false,
  inherits: readonly FXInheritRequest[] = [],
): { spawn: FXKernelTarget; update: FXKernelTarget; tryGpuSimulation: boolean } {
  const suffix = canonicalAttributeSuffix(attributes);
  const inheritPlan = planInherits(inherits);
  const buffers = slotOrder([...FX_CORE_BUFFERS, ...attributeBuffers(attributes)]);
  const attributeInputEntries = attributeInputs(attributes);
  const attributeSlotEntries = attributeSlots(attributes);

  const spawn: FXKernelTarget = {
    name: `particle-behavior-spawn${suffix}`,
    buffers,
    inputs: [
      ...readInputs,
      ...SPAWN_EMITTER_HOST_INPUTS,
      ...PARTICLE_INDEX_INPUTS,
      FX_SEED_INPUT,
      ...attributeInputEntries,
      ...inheritInputs(inheritPlan),
    ],
    outputs: [...writeOutputs(true), ...attributeSlotEntries],
    birth: true,
    ...(inheritPlan.layout.stride === 0 ? {} : { inherit: inheritPlan }),
  };
  const update: FXKernelTarget = {
    name: `particle-behavior-update${suffix}`,
    buffers,
    inputs: [
      ...readInputs,
      FX_DT_INPUT,
      ...EMITTER_HOST_INPUTS,
      ...PARTICLE_INDEX_INPUTS,
      FX_SEED_INPUT,
      ...attributeInputEntries,
    ],
    outputs: [...writeOutputs(false), ...attributeSlotEntries],
    // No integration: motion is an `integrate-motion` node.
    killSlot: FX_KILL_SLOT,
  };
  return { spawn, update, tryGpuSimulation };
}

/**
 * {@link buildParticleBehaviorTargets} for `graph`: its attributes (or `attributes`, when the
 * caller already merged them with another graph's) and what its newborns inherit.
 */
export function particleBehaviorTargetsFor(
  graph: FXGraph<FXBehaviorNode>,
  tryGpuSimulation = false,
  attributes: readonly FXAttributeRequest[] = collectAttributeRequests(graph).requests,
): FXBehaviorTargets & { spawn: FXKernelTarget } {
  return buildParticleBehaviorTargets(
    attributes,
    tryGpuSimulation,
    collectInheritRequests(graph).requests,
  );
}
