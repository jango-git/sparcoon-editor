import type { FXValueType } from "../../core/socket/FXValueType";

/** Describes a uniform a node wants to declare. The `value` is kept `unknown` so the IR stays
 *  three-independent; the material adapter turns it into an actual `THREE.IUniform`. */
export interface FXUniformDescriptor {
  readonly type: FXValueType;
  /** Initial value (number, texture, color, ...). Interpreted by the adapter. */
  value: unknown;
  /** Naming hint; the compiler still guarantees the final name is collision-free. */
  readonly hint?: string;
  /** Forces a **stable, verbatim** uniform name (a param node's user-chosen slot) instead of the
   *  auto-numbered `hint`; two allocations with the same `name` share one uniform (a type clash
   *  between them is a compile error). Survives structural edits, unlike `hint`, so a timeline
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
  /** Mutable value slot shared with the material's uniform object. */
  value: unknown;
  /** Present iff this is an external sampler (a Texture): the app-supplied slot name. */
  readonly external?: string;
}

/** A vertex-to-fragment varying allocated during compilation. */
export interface FXVarying {
  readonly name: string;
  readonly type: FXValueType;
}

/** Per-stage accumulation of generated GLSL. */
export interface FXCompiledStage {
  /** `varying <type> <name>;` declarations. */
  readonly varyingDeclarations: readonly string[];
  /** Deduplicated helper function definitions, in emission order. */
  readonly helperFunctions: readonly string[];
  /** Ordered statements to splice into this stage's main body. */
  readonly body: readonly string[];
}

/** The compiler's Three-independent intermediate representation; a material adapter consumes
 *  this and assembles it into the host's own `ShaderMaterial` source. */
export interface FXCompiledShader {
  /** Final uniform map keyed by generated name. */
  readonly uniforms: Readonly<Record<string, FXUniformHandle>>;
  /** `uniform <type> <name>;` declarations shared by both stages. */
  readonly uniformDeclarations: readonly string[];
  readonly vertex: FXCompiledStage;
  readonly fragment: FXCompiledStage;
  /** GLSL expression bound to each target output slot (e.g. `"albedo"` -> the final `vec4`
   *  expression), keyed by {@link FXTargetOutput.slot}. */
  readonly outputs: Readonly<Record<string, string>>;
  /** Deterministic structural hash, suitable as a program cache key. */
  readonly hash: string;
}
