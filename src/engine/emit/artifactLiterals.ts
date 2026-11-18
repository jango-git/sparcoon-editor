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
  FXKernelResourceFields,
} from "../behavior/FXCompiledKernel";
import type { FXFusedProgramStandard } from "../behavior/FXKernelBuildStandard.Internal";
import {
  kernelResourceFields,
  resourceFieldsOf,
  SPAWN_KERNEL_PARAMETERS,
  UPDATE_KERNEL_PARAMETERS,
} from "../behavior/FXKernelShared.Internal";
import { assembleKernelBody } from "../behavior/FXParticleBehaviorKernel.Internal";
import type { FXCompiledDrawStage } from "../core/codegen/drawStage.Internal";
import { DRAW_COMPUTE_PARAMETERS } from "../core/codegen/drawStageBuild.Internal";
import {
  type FXGLSLHelperName,
  type FXJSHelperName,
  glslHelperSource,
} from "../core/ir/FXHelpers.Internal";
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
    helperFunctions: stage.helpers.map(glslHelperSource),
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

/** How a module prints one stage's body: an array literal (expression text). */
export interface FXStagePrinter {
  body(stage: FXRenderStagePath, body: readonly string[]): string;
}

/** The programs of a render artifact, by the property that holds each. */
export type FXRenderProgramKey = "color" | "shadow";

/** One stage of a render artifact: its program's property, and its own within it. */
export interface FXRenderStagePath {
  readonly program: FXRenderProgramKey;
  readonly stage: "vertex" | "fragment";
}

/** Every line written out. */
const PLAIN_STAGES: FXStagePrinter = {
  body: (_stage, body) => JSON.stringify(body),
};

/** A stage literal: its helpers by the names the module imports them by, its body by `printer`;
 *  a fragment stage's with what it reads of the surface frame. */
function stageLiteral(
  path: FXRenderStagePath,
  stage: FXCompiledStage,
  printer: FXStagePrinter,
): string {
  const surface =
    path.stage === "fragment"
      ? `, surfaceReads: ${JSON.stringify(surfaceReadsOf(stage.targetReads))}`
      : "";
  return (
    `{ uniformDeclarations: ${JSON.stringify(stage.uniformDeclarations)}, ` +
    `helperFunctions: [${stage.helpers.join(", ")}], ` +
    `body: ${printer.body(path, stage.body)}, ` +
    `particleReads: ${JSON.stringify(particleReadsOf(stage.targetReads))}${surface} }`
  );
}

/** The `FXRenderProgram` object literal of `program` (the artifact's `key` program). */
function programLiteral(
  key: FXRenderProgramKey,
  program: FXCompiledProgram,
  printer: FXStagePrinter,
): string {
  const vertex = stageLiteral({ program: key, stage: "vertex" }, program.vertex, printer);
  const fragment = stageLiteral({ program: key, stage: "fragment" }, program.fragment, printer);
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

/**
 * The module's import of `helpers` (JS and GLSL alike, each once) from the `helpers` entry of the
 * runtime at `specifier`; none without helpers.
 */
export function helpersImportLines(
  specifier: string,
  helpers: Iterable<FXJSHelperName | FXGLSLHelperName>,
): string[] {
  const names = [...new Set(helpers)].sort();
  return names.length === 0
    ? []
    : [
        "import {",
        ...names.map((name) => `  ${name},`),
        `} from ${JSON.stringify(`${specifier}/helpers`)};`,
      ];
}

/** The JS helpers a render artifact's `compute` calls, which the module imports. */
export function collectDrawHelpers(shader: FXCompiledShader): readonly FXJSHelperName[] {
  return shader.draw?.helpers ?? [];
}

/** The GLSL helpers of every stage of a render artifact, which the module imports. */
export function collectShaderHelpers(shader: FXCompiledShader): readonly FXGLSLHelperName[] {
  const programs = shader.shadow === undefined ? [shader.color] : [shader.color, shader.shadow];
  return programs.flatMap((program) => [...program.vertex.helpers, ...program.fragment.helpers]);
}

/** The JS helpers of both behavior phases, which the module imports. */
export function collectBehaviorHelpers(kernel: FXCompiledKernel): readonly FXJSHelperName[] {
  return [...(kernel.spawn?.helpers ?? []), ...kernel.update.helpers];
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

/** The resource lines (`meshSurfaces`, `volumes`) of an artifact literal at `indent`. None for a
 *  resource kind it does not sample. */
function resourceLines(fields: FXKernelResourceFields, indent: string): string[] {
  return Object.entries(resourceFieldsOf(fields)).map(
    ([key, resources]) => `${indent}${key}: ${JSON.stringify(resources)},`,
  );
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
 *  when embedded at any depth. The module imports the helpers they call (see
 *  {@link collectBehaviorHelpers}). */
export function behaviorArtifactBody(kernel: FXCompiledKernel, baseIndent = ""): string {
  const inner = `${baseIndent}  `;
  const methodBody = `${inner}  `;
  const lines: string[] = [
    "{",
    `${inner}buffers: ${JSON.stringify(kernel.update.buffers)},`,
    `${inner}bindings: ${bindingsLiteral(kernel)},`,
    ...resourceLines(kernelResourceFields(kernel), inner),
    ...(kernel.inherit === undefined
      ? []
      : [`${inner}inherit: ${JSON.stringify(kernel.inherit.layout)},`]),
  ];
  if (kernel.spawn !== undefined) {
    lines.push(`${inner}spawn(${SPAWN_KERNEL_PARAMETERS.join(", ")}) {`);
    lines.push(indentBody(assembleKernelBody(kernel.spawn, "spawn"), methodBody));
    lines.push(`${inner}},`);
  }
  lines.push(`${inner}update(${UPDATE_KERNEL_PARAMETERS.join(", ")}) {`);
  lines.push(indentBody(assembleKernelBody(kernel.update, "update"), methodBody));
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

/** The element expressions of a kernel's vertex lines: a line written out, a helper by its name. */
export function kernelLineLiterals(program: FXFusedProgramStandard): string[] {
  return program.vertexLines.map((line) =>
    typeof line === "string" ? JSON.stringify(line) : line.helper,
  );
}

/** The GLSL helpers a GPU kernel links, which the module imports. */
export function collectKernelHelpers(program: FXFusedProgramStandard): readonly FXGLSLHelperName[] {
  return program.vertexLines.flatMap((line) => (typeof line === "string" ? [] : [line.helper]));
}

/** The `FXParticleKernelArtifact` object literal (bare `{ ... }`, for `const <name>:
 *  FXParticleKernelArtifact = <body>;`) - the standard-tier (GPU/transform-feedback) sibling of
 *  {@link behaviorArtifactBody}. `sources` are the two sources' expressions in the module (by
 *  default written out, the helpers by name). */
export function gpuKernelArtifactBody(
  program: FXFusedProgramStandard,
  sources: { readonly vertexSource: string; readonly fragmentSource: string } = {
    vertexSource: `[${kernelLineLiterals(program).join(", ")}].join("\\n")`,
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
    ...resourceLines(program, "  "),
    ...(program.sceneDepth === true ? ["  sceneDepth: true,"] : []),
    ...(program.draw === undefined ? [] : [drawComputeLiteral(program.draw.stage)]),
    "}",
  ].join("\n");
}

/** The JS helpers a GPU kernel's `compute` calls, which the module imports. */
export function collectKernelDrawHelpers(
  program: FXFusedProgramStandard,
): readonly FXJSHelperName[] {
  return program.draw?.stage.helpers ?? [];
}
