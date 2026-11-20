import type { FXCompiledDrawStage } from "../../core/codegen/drawStage.Internal";
import type { FXRenderCapabilities } from "../../core/compiler/collectRenderCapabilities";
import type { FXGLSLHelperName } from "../../core/ir/FXHelpers.Internal";
import type { FXValueType } from "../../core/socket/FXValueType";

/** A uniform a node declares. `value` is `unknown` to keep the IR independent of three. */
export interface FXUniformDescriptor {
  readonly type: FXValueType;
  /** Initial value (number, texture, color, ...). Interpreted by the adapter. */
  value: unknown;
  /**
   * Fixed uniform name (a param node's slot). Allocations sharing a name share one uniform, a type
   * clash is a compile error. The name survives edits, so a timeline can drive it through
   * `applyValues`.
   */
  readonly name?: string;
  /** Marks an **external** sampler (a Texture): declared but carrying no baked value - the host
   *  supplies the texture by slot name at load / via `applyValues`. */
  readonly external?: boolean;
}

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

export interface FXVarying {
  readonly name: string;
  readonly type: FXValueType;
  /** `flat` marks a value the same at all of a primitive's vertices, or an integer, which cannot
   *  interpolate - the runtime's `FXVaryingDecl.interpolation`, the same on every tier. */
  readonly interpolation: "smooth" | "flat";
}

export interface FXCompiledStage {
  /** `uniform <type> <name>;` of each uniform this stage's code reads (see
   *  `stageUniformDeclarations`). */
  readonly uniformDeclarations: readonly string[];
  /** The helpers this stage's code calls, each behind the ones it calls. */
  readonly helpers: readonly FXGLSLHelperName[];
  /** Ordered statements to splice into this stage's main body. */
  readonly body: readonly string[];
  /** The target inputs this stage's code reads (sorted, each once), recorded as it is printed. */
  readonly targetReads: readonly string[];
}

/** One shader program of a compiled graph - the runtime's `FXRenderProgram`: its two stages,
 *  what it carries between them, and what each of its output slots reads. */
export interface FXCompiledProgram {
  /** What the vertex stage carries to the fragment stage, declared in both. */
  readonly varyings: readonly FXVarying[];
  readonly vertex: FXCompiledStage;
  readonly fragment: FXCompiledStage;
  /** GLSL expression bound to each output slot (e.g. `"albedo"` -> the final `vec4`
   *  expression), keyed by slot. */
  readonly outputs: Readonly<Record<string, string>>;
}

export interface FXCompiledShader {
  /** Final uniform map keyed by generated name, shared by both programs. */
  readonly uniforms: Readonly<Record<string, FXUniformHandle>>;
  /** The program drawing the graph, its outputs keyed by {@link FXTargetOutput.slot}. */
  readonly color: FXCompiledProgram;
  /** The program casting its shadow, its outputs keyed by `FXShadowOutput.slot`; absent
   *  for a target with no `FXTarget.shadow`. */
  readonly shadow?: FXCompiledProgram;
  /** What the compiled nodes ask of the runtime (lighting, scene depth) - read from the same
   *  reachable nodes the code came from, so the artifact can never disagree with it. */
  readonly capabilities: FXRenderCapabilities;
  /** What the graph computes once per tick on the CPU (its artifact's `compute`), when anything. */
  readonly draw?: FXCompiledDrawStage;
  /** Deterministic structural hash, suitable as a program cache key. */
  readonly hash: string;
}

export function zeroValue(type: FXValueType): number | number[] {
  return type.components === 1 ? 0 : new Array<number>(type.components).fill(0);
}
