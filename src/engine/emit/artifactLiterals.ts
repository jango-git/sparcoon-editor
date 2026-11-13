import type {
  FXFragmentStageSource,
  FXGeometrySource,
  FXRenderMode,
  FXShaderStageSource,
  FXVaryingDecl,
} from "sparcoon";

import type {
  FXCompiledKernel,
  FXCompiledKernelPhase,
  FXKernelBindingHandle,
} from "../behavior/FXCompiledKernel";
import type { FXFusedProgramStandard } from "../behavior/FXKernelBuildStandard.Internal";
import { SLOTS_PARAMETER } from "../behavior/FXKernelShared.Internal";
import {
  assembleKernelBody,
  SPAWN_LOOP_HEADER,
  UPDATE_LOOP_HEADER,
} from "../behavior/FXParticleBehaviorKernel.Internal";
import type { FXCompiledDrawStage } from "../core/codegen/drawStage.Internal";
import { DRAW_COMPUTE_PARAMETERS } from "../core/codegen/drawStageBuild.Internal";
import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import type { FXValueType } from "../core/socket/FXValueType";
import type {
  FXCompiledProgram,
  FXCompiledShader,
  FXCompiledStage,
} from "../render/compiler/FXCompiledShader";
import { zeroValue } from "../render/compiler/FXCompiledShader";
import { particleReadsOf, surfaceReadsOf } from "../render/target/FXParticleRenderTarget";

/** Serializes the compiler IR into TypeScript object literals, shared by {@link emitEffectModule}
 *  and {@link emitProjectModule}. Every function returns a bare `{ ... }` body, so the caller
 *  owns the `const <name> = <body>;` naming and can emit many entities per file. */

/** The `{name, components}` decls of the attributes a render reads (`attributeReads`). */
function attributeDecls(attributes: readonly FXAttributeRequest[]): string {
  return JSON.stringify(
    attributes.map((attribute) => ({
      name: attribute.name,
      components: attribute.type.components,
    })),
  );
}

/**
 * The runtime's {@link FXShaderStageSource} for one compiled stage: its code, and what that code
 * reads of each particle. Shared with {@link assembleArtifacts}'s in-memory assembler, so the
 * exported module and the live preview never part ways on it.
 */
export function stageSource(stage: FXCompiledStage): FXShaderStageSource {
  return {
    uniformDeclarations: [...stage.uniformDeclarations],
    helperFunctions: [...stage.helperFunctions],
    body: [...stage.body],
    particleReads: particleReadsOf(stage.targetReads),
  };
}

/** The runtime's {@link FXVaryingDecl}s for what a compiled program carries between its stages.
 *  Shared with {@link assembleArtifacts}'s in-memory assembler, like {@link stageSource}. */
export function varyingDecls(program: FXCompiledProgram): FXVaryingDecl[] {
  return program.varyings.map((varying) => ({
    name: varying.name,
    type: varying.type.glslTypeName,
    interpolation: varying.interpolation,
  }));
}

/** {@link stageSource} for the fragment stage, which also records what it reads of the surface frame. */
export function fragmentStageSource(stage: FXCompiledStage): FXFragmentStageSource {
  return { ...stageSource(stage), surfaceReads: surfaceReadsOf(stage.targetReads) };
}

/** How a module prints one stage's helpers and body: each an array literal (expression text). */
export interface FXStagePrinter {
  helpers(stage: FXRenderStagePath, helperFunctions: readonly string[]): string;
  body(stage: FXRenderStagePath, body: readonly string[]): string;
}

/** The programs of a render artifact, by the property that holds each. */
export type FXRenderProgramKey = "color" | "shadow";

/** One stage of a render artifact: its program's property, and its own within it. */
export interface FXRenderStagePath {
  readonly program: FXRenderProgramKey;
  readonly stage: "vertex" | "fragment";
}

/** Every helper and line written out. */
const PLAIN_STAGES: FXStagePrinter = {
  helpers: (_stage, helperFunctions) => JSON.stringify(helperFunctions),
  body: (_stage, body) => JSON.stringify(body),
};

function stageLiteral(
  stage: FXRenderStagePath,
  source: FXShaderStageSource | FXFragmentStageSource,
  printer: FXStagePrinter,
): string {
  const surface =
    "surfaceReads" in source ? `, surfaceReads: ${JSON.stringify(source.surfaceReads)}` : "";
  return (
    `{ uniformDeclarations: ${JSON.stringify(source.uniformDeclarations)}, ` +
    `helperFunctions: ${printer.helpers(stage, source.helperFunctions)}, ` +
    `body: ${printer.body(stage, source.body)}, ` +
    `particleReads: ${JSON.stringify(source.particleReads)}${surface} }`
  );
}

/** The `FXRenderProgram` object literal of `program` (the artifact's `key` program). */
function programLiteral(
  key: FXRenderProgramKey,
  program: FXCompiledProgram,
  printer: FXStagePrinter,
): string {
  const vertex = stageLiteral(
    { program: key, stage: "vertex" },
    stageSource(program.vertex),
    printer,
  );
  const fragment = stageLiteral(
    { program: key, stage: "fragment" },
    fragmentStageSource(program.fragment),
    printer,
  );
  return [
    "{",
    `    varyings: ${JSON.stringify(varyingDecls(program))},`,
    `    vertex: ${vertex},`,
    `    fragment: ${fragment},`,
    `    outputs: ${JSON.stringify(program.outputs)},`,
    "  }",
  ].join("\n");
}

/** Whether any declared uniform is a `sampler2D` - drives whether the module imports texture helpers. */
export function uniformsUseTexture(shader: FXCompiledShader): boolean {
  return Object.values(shader.uniforms).some((handle) => handle.type.glslTypeName === "sampler2D");
}

function serializeUniformValue(value: unknown, name: string): string {
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value) && value.every((component) => typeof component === "number")) {
    return `[${value.join(", ")}]`;
  }
  throw new Error(
    `artifactLiterals: uniform "${name}" has a non-serializable value. Numbers, vectors, and ` +
      `external (asset) samplers export; a baked/generated texture (no node produces one today) ` +
      `cannot yet be serialized to a module.`,
  );
}

function uniformsLiteral(shader: FXCompiledShader): string {
  const entries = Object.entries(shader.uniforms).map(([name, handle]) => {
    // An external sampler carries no baked value: the host binds it by slot name at load time
    // (via `fromArtifacts({ textures })` / `applyValues`), so emit only the slot, not a value.
    if (handle.external !== undefined) {
      return `${JSON.stringify(name)}: { type: "sampler2D", external: ${JSON.stringify(handle.external)} }`;
    }
    const type = handle.type.glslTypeName;
    return `${JSON.stringify(name)}: { type: ${JSON.stringify(type)}, value: ${serializeUniformValue(handle.value, name)} }`;
  });
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/** The `FXRenderArtifact` object literal (bare `{ ... }`, for `const <name>: FXRenderArtifact = <body>;`),
 *  its stages printed by `stages` (in full by default). */
export function renderArtifactBody(
  shader: FXCompiledShader,
  geometry: FXGeometrySource,
  attributes: readonly FXAttributeRequest[],
  renderMode: FXRenderMode,
  stages: FXStagePrinter = PLAIN_STAGES,
): string {
  return [
    "{",
    `  lightingIntrinsics: ${JSON.stringify(shader.capabilities.lightingIntrinsics)},`,
    `  sceneDepth: ${JSON.stringify(shader.capabilities.sceneDepth)},`,
    `  geometry: ${JSON.stringify(geometry)},`,
    `  options: { renderMode: ${JSON.stringify(renderMode)} },`,
    `  color: ${programLiteral("color", shader.color, stages)},`,
    ...(shader.shadow === undefined
      ? []
      : [`  shadow: ${programLiteral("shadow", shader.shadow, stages)},`]),
    `  uniforms: ${uniformsLiteral(shader)},`,
    `  attributeReads: ${attributeDecls(attributes)},`,
    ...(shader.draw === undefined ? [] : [drawComputeLiteral(shader.draw)]),
    "}",
  ].join("\n");
}

/** The `compute` method of a render artifact: its statements as written source. Its helpers are
 *  module-scope imports (see {@link collectDrawHelpers}), never inlined here. */
function drawComputeLiteral(stage: FXCompiledDrawStage): string {
  return [
    `  compute(${DRAW_COMPUTE_PARAMETERS.join(", ")}) {`,
    ...stage.statements.map((statement) => `    ${statement}`),
    "  },",
  ].join("\n");
}

/** The JS helpers a render artifact's `compute` calls, to hoist to module scope like a behavior's. */
export function collectDrawHelpers(shader: FXCompiledShader): readonly string[] {
  return shader.draw?.helpers ?? [];
}

/** Behavior math helpers, deduped across both phases, to hoist to module scope. */
export function collectBehaviorHelpers(kernel: FXCompiledKernel): string[] {
  const helpers = new Set<string>();
  for (const helper of kernel.spawn?.helpers ?? []) {
    helpers.add(helper);
  }
  for (const helper of kernel.update.helpers) {
    helpers.add(helper);
  }
  return [...helpers];
}

function serializeBindingValue(value: number | Float32Array): string {
  if (typeof value === "number") {
    return String(value);
  }
  return `new Float32Array([${[...value].join(", ")}])`;
}

/** The `bindings` record both phases share. A same-named binding carrying a different value
 *  across phases would corrupt one phase, so it is rejected loudly rather than overwritten. */
function bindingsLiteral(kernel: FXCompiledKernel): string {
  const merged = new Map<string, number | Float32Array>();
  const collect = (phase: FXCompiledKernelPhase | undefined): void => {
    if (phase === undefined) {
      return;
    }
    for (const [name, handle] of Object.entries(phase.bindings)) {
      const existing = merged.get(name);
      if (existing !== undefined && existing !== handle.value) {
        throw new Error(
          `artifactLiterals: binding "${name}" has conflicting values across the spawn and update phases`,
        );
      }
      merged.set(name, handle.value);
    }
  };
  collect(kernel.spawn);
  collect(kernel.update);
  if (merged.size === 0) {
    return "{}";
  }
  const entries = [...merged].map(
    ([name, value]) => `${JSON.stringify(name)}: { value: ${serializeBindingValue(value)} }`,
  );
  return `{ ${entries.join(", ")} }`;
}

/** Indents each line of a kernel body by `indent`, for the emitted method block. */
function indentBody(body: string, indent: string): string {
  return body
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/** The `FXBehaviorArtifact` object literal, with `bindings` inlined and the authored `spawn`/
 *  `update` methods. `baseIndent` is the leading indentation of the `{`, so nested lines align
 *  when embedded at any depth. Math helpers are NOT included - the caller hoists the union of
 *  {@link collectBehaviorHelpers} to module scope. */
export function behaviorArtifactBody(kernel: FXCompiledKernel, baseIndent = ""): string {
  const inner = `${baseIndent}  `;
  const methodBody = `${inner}  `;
  const lines: string[] = [
    "{",
    `${inner}buffers: ${JSON.stringify(kernel.update.buffers)},`,
    `${inner}bindings: ${bindingsLiteral(kernel)},`,
  ];
  if (kernel.spawn !== undefined) {
    lines.push(`${inner}spawn(${SLOTS_PARAMETER}, start, count, bindings, emitter) {`);
    lines.push(indentBody(assembleKernelBody(kernel.spawn, SPAWN_LOOP_HEADER), methodBody));
    lines.push(`${inner}},`);
  }
  lines.push(`${inner}update(${SLOTS_PARAMETER}, count, dt, bindings, emitter) {`);
  lines.push(indentBody(assembleKernelBody(kernel.update, UPDATE_LOOP_HEADER), methodBody));
  lines.push(`${inner}},`);
  lines.push(`${baseIndent}}`);
  return lines.join("\n");
}

function gpuBindingsLiteral(
  bindings: Readonly<Record<string, FXKernelBindingHandle>>,
  drawUniforms: Readonly<Record<string, FXValueType>>,
): string {
  const entries = [
    ...Object.entries(bindings).map(
      ([name, handle]) =>
        `${JSON.stringify(name)}: { value: ${serializeBindingValue(handle.value)} }`,
    ),
    // The draw uniforms, seeded at zero: `compute` writes them every pass.
    ...Object.entries(drawUniforms).map(
      ([name, type]) => `${JSON.stringify(name)}: { value: ${JSON.stringify(zeroValue(type))} }`,
    ),
  ];
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/** The `FXParticleKernelArtifact` object literal (bare `{ ... }`, for `const <name>:
 *  FXParticleKernelArtifact = <body>;`) - the standard-tier (GPU/transform-feedback) sibling of
 *  {@link behaviorArtifactBody}. Unlike the JS artifact, there are no per-phase math helpers to
 *  hoist separately: `program.vertexSource` already carries every GLSL helper inline (the fused
 *  assembler's own doc comment - `FXKernelBuildStandard.Internal.ts`). `sources` are the two
 *  sources' expressions in the module (by default written out). */
export function gpuKernelArtifactBody(
  program: FXFusedProgramStandard,
  sources: { readonly vertexSource: string; readonly fragmentSource: string } = {
    vertexSource: JSON.stringify(program.vertexSource),
    fragmentSource: JSON.stringify(program.fragmentSource),
  },
): string {
  return [
    "{",
    `  vertexSource: ${sources.vertexSource},`,
    `  fragmentSource: ${sources.fragmentSource},`,
    `  buffers: ${JSON.stringify(program.buffers)},`,
    `  transformFeedbackVaryings: ${JSON.stringify(program.transformFeedbackVaryings)},`,
    `  bindings: ${gpuBindingsLiteral(program.bindings, program.draw?.uniforms ?? {})},`,
    ...(program.draw === undefined ? [] : [drawComputeLiteral(program.draw.stage)]),
    "}",
  ].join("\n");
}

/** The JS helpers a GPU kernel's `compute` calls, to hoist to module scope like a behavior's. */
export function collectKernelDrawHelpers(program: FXFusedProgramStandard): readonly string[] {
  return program.draw?.stage.helpers ?? [];
}
