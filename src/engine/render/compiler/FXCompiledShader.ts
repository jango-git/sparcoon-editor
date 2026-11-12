import type { FXCompiledDrawStage } from "../../core/codegen/drawStage.Internal";
import type { FXRenderCapabilities } from "../../core/compiler/collectRenderCapabilities";
import type { FXValueType } from "../../core/socket/FXValueType";

/** Describes a uniform a node wants to declare. The `value` is kept `unknown` so the IR stays
 *  three-independent; the material adapter turns it into an actual `THREE.IUniform`. */
export interface FXUniformDescriptor {
  readonly type: FXValueType;
  /** Initial value (number, texture, color, ...). Interpreted by the adapter. */
  value: unknown;
  /** Forces a **stable, verbatim** uniform name (a param node's user-chosen slot) instead of a
   *  generated one; two allocations with the same `name` share one uniform (a type clash
   *  between them is a compile error). Survives structural edits, unlike a generated name, so a timeline
   *  can drive it by name through {@link FXEmitter.applyValues}. */
  readonly name?: string;
  /** Marks an **external** sampler (a Texture): declared but carrying no baked value - the host
   *  supplies the texture by slot name at load / via `applyValues`. */
  readonly external?: boolean;
}

/** Live handle returned when a uniform is allocated; node instances keep this to push runtime
 *  updates (editor scrubbing) into the compiled material. */
export interface FXUniformHandle {
  /** Final, collision-free uniform name emitted into the shader. */
  readonly name: string;
  /** Its type, as declared. */
  readonly type: FXValueType;
  /** Mutable value slot shared with the material's uniform object. */
  value: unknown;
  /** Present iff this is an external sampler (a Texture): the app-supplied slot name. */
  readonly external?: string;
}

/** A vertex-to-fragment varying allocated during compilation. */
export interface FXVarying {
  readonly name: string;
  readonly type: FXValueType;
  /** `flat` marks a value the same at all of a primitive's vertices, or an integer, which cannot
   *  interpolate - the runtime's `FXVaryingDecl.interpolation`, the same on every tier. */
  readonly interpolation: "smooth" | "flat";
}

/** Per-stage accumulation of generated GLSL. */
export interface FXCompiledStage {
  /** `uniform <type> <name>;` of each uniform this stage's code reads (see
   *  `stageUniformDeclarations`). */
  readonly uniformDeclarations: readonly string[];
  /** Deduplicated helper function definitions, in emission order. */
  readonly helperFunctions: readonly string[];
  /** Ordered statements to splice into this stage's main body. */
  readonly body: readonly string[];
  /** The target inputs this stage's code reads (sorted, each once), recorded as it is printed. */
  readonly targetReads: readonly string[];
}

/** The compiler's Three-independent intermediate representation; a material adapter consumes
 *  this and assembles it into the host's own `ShaderMaterial` source. */
export interface FXCompiledShader {
  /** Final uniform map keyed by generated name. */
  readonly uniforms: Readonly<Record<string, FXUniformHandle>>;
  /** What the vertex stage carries to the fragment stage, declared in both. */
  readonly varyings: readonly FXVarying[];
  readonly vertex: FXCompiledStage;
  readonly fragment: FXCompiledStage;
  /** GLSL expression bound to each target output slot (e.g. `"albedo"` -> the final `vec4`
   *  expression), keyed by {@link FXTargetOutput.slot}. */
  readonly outputs: Readonly<Record<string, string>>;
  /** What the compiled nodes ask of the runtime (lighting, scene depth) - read from the same
   *  reachable nodes the code came from, so the artifact can never disagree with it. */
  readonly capabilities: FXRenderCapabilities;
  /** What the graph computes once per tick on the CPU (its artifact's `compute`), when anything. */
  readonly draw?: FXCompiledDrawStage;
  /** Deterministic structural hash, suitable as a program cache key. */
  readonly hash: string;
}

/** A uniform's value before anything writes it: zero in every component. */
export function zeroValue(type: FXValueType): number | number[] {
  return type.components === 1 ? 0 : new Array<number>(type.components).fill(0);
}
