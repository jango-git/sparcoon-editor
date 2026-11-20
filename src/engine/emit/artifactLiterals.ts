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

/**
 * Serializes the compiler IR into object literals. Each function returns a bare `{ ... }` body, and the
 * caller names the constant.
 */

function attributeDecls(attributes: readonly FXAttributeRequest[]): string {
  return JSON.stringify(
    attributes.map((attribute) => ({
      name: attribute.name,
      components: attribute.type.components,
    })),
  );
}

/** The runtime's stage source, shared with the in-memory assembler. */
export function stageSource(stage: FXCompiledStage): FXShaderStageSource {
  return {
    uniformDeclarations: [...stage.uniformDeclarations],
    helperFunctions: stage.helpers.map(glslHelperSource),
    body: [...stage.body],
    particleReads: particleReadsOf(stage.targetReads),
  };
}

export function varyingDecls(program: FXCompiledProgram): FXVaryingDecl[] {
  return program.varyings.map((varying) => ({
    name: varying.name,
    type: varying.type.glslTypeName,
    interpolation: varying.interpolation,
  }));
}

export function fragmentStageSource(stage: FXCompiledStage): FXFragmentStageSource {
  return { ...stageSource(stage), surfaceReads: surfaceReadsOf(stage.targetReads) };
}

export interface FXStagePrinter {
  body(stage: FXRenderStagePath, body: readonly string[]): string;
}

export type FXRenderProgramKey = "color" | "shadow";

export interface FXRenderStagePath {
  readonly program: FXRenderProgramKey;
  readonly stage: "vertex" | "fragment";
}

const PLAIN_STAGES: FXStagePrinter = {
  body: (_stage, body) => JSON.stringify(body),
};

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
    // External sampler: emit the slot only, the host binds the texture by name.
    if (handle.external !== undefined) {
      return `${JSON.stringify(name)}: { type: "sampler2D", external: ${JSON.stringify(handle.external)} }`;
    }
    const type = handle.type.glslTypeName;
    return `${JSON.stringify(name)}: { type: ${JSON.stringify(type)}, value: ${serializeUniformValue(handle.value, name)} }`;
  });
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/** The `FXRenderArtifact` literal body. `stages` prints each stage (in full by default). */
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

/** The `compute` method source. Its helpers are module imports, never inlined. */
function drawComputeLiteral(stage: FXCompiledDrawStage): string {
  return [
    `  compute(${DRAW_COMPUTE_PARAMETERS.join(", ")}) {`,
    ...stage.statements.map((statement) => `    ${statement}`),
    "  },",
  ].join("\n");
}

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

export function collectDrawHelpers(shader: FXCompiledShader): readonly FXJSHelperName[] {
  return shader.draw?.helpers ?? [];
}

export function collectShaderHelpers(shader: FXCompiledShader): readonly FXGLSLHelperName[] {
  const programs = shader.shadow === undefined ? [shader.color] : [shader.color, shader.shadow];
  return programs.flatMap((program) => [...program.vertex.helpers, ...program.fragment.helpers]);
}

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

function resourceLines(fields: FXKernelResourceFields, indent: string): string[] {
  return Object.entries(resourceFieldsOf(fields)).map(
    ([key, resources]) => `${indent}${key}: ${JSON.stringify(resources)},`,
  );
}

function indentBody(body: string, indent: string): string {
  return body
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/** The `FXBehaviorArtifact` literal body. `baseIndent` is the indentation of the opening `{`. */
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

export function kernelLineLiterals(program: FXFusedProgramStandard): string[] {
  return program.vertexLines.map((line) =>
    typeof line === "string" ? JSON.stringify(line) : line.helper,
  );
}

export function collectKernelHelpers(program: FXFusedProgramStandard): readonly FXGLSLHelperName[] {
  return program.vertexLines.flatMap((line) => (typeof line === "string" ? [] : [line.helper]));
}

/**
 * The standard-tier (transform-feedback) sibling of behaviorArtifactBody. `sources` are the two
 * sources' expressions.
 */
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

export function collectKernelDrawHelpers(
  program: FXFusedProgramStandard,
): readonly FXJSHelperName[] {
  return program.draw?.stage.helpers ?? [];
}
