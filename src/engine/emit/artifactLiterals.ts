import type { FXAttributeRequest } from "../core/socket/FXAttribute";
import type { FXCompiledShader } from "../render/compiler/FXCompiledShader";
import type {
  FXCompiledKernel,
  FXCompiledKernelPhase,
  FXKernelBindingHandle,
} from "../behavior/FXCompiledKernel";
import type { FXGeometrySource, FXRenderMode } from "sparcoon";
import {
  assembleKernelBody,
  SPAWN_LOOP_HEADER,
  UPDATE_LOOP_HEADER,
} from "../behavior/FXParticleBehaviorKernel.Internal";
import type { FXFusedProgramStandard } from "../behavior/FXKernelBuildStandard.Internal";

/** Serializes the compiler IR into TypeScript object literals, shared by {@link emitEffectModule}
 *  and {@link emitProjectModule}. Every function returns a bare `{ ... }` body, so the caller
 *  owns the `const <name> = <body>;` naming and can emit many entities per file. */

/** `{name, components}` decls the runtime merges to size the shared attribute buffers. */
export function attributeDecls(attributes: readonly FXAttributeRequest[]): string {
  return JSON.stringify(
    attributes.map((attribute) => ({
      name: attribute.name,
      components: attribute.type.components,
    })),
  );
}

function stageLiteral(stage: FXCompiledShader["vertex"]): string {
  return (
    `{ varyingDeclarations: ${JSON.stringify(stage.varyingDeclarations)}, ` +
    `helperFunctions: ${JSON.stringify(stage.helperFunctions)}, ` +
    `body: ${JSON.stringify(stage.body)} }`
  );
}

/** Parses `uniform <glslType> <name>;` declarations into a name -> type map. Shared with
 *  {@link assembleArtifacts}'s in-memory assembler, so the two never part ways on the format. */
export function uniformTypes(declarations: readonly string[]): Map<string, string> {
  const types = new Map<string, string>();
  for (const declaration of declarations) {
    // RegExp#exec is the external API that demands null; converted once here at the boundary.
    const match = /^uniform\s+(\S+)\s+([A-Za-z_$][\w$]*)\s*;/.exec(declaration) ?? undefined;
    if (match !== undefined) {
      const glslType = match[1];
      const name = match[2];
      // Both groups are mandatory in the pattern above, so a successful match always
      // captures them; this guard only proves it to noUncheckedIndexedAccess.
      if (glslType === undefined || name === undefined) {
        throw new Error("uniformTypes: matched uniform declaration without captured groups");
      }
      types.set(name, glslType);
    }
  }
  return types;
}

/** Whether any declared uniform is a `sampler2D` - drives whether the module imports texture helpers. */
export function uniformsUseTexture(shader: FXCompiledShader): boolean {
  const types = uniformTypes(shader.uniformDeclarations);
  for (const name of Object.keys(shader.uniforms)) {
    if (types.get(name) === "sampler2D") {
      return true;
    }
  }
  return false;
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
  const types = uniformTypes(shader.uniformDeclarations);
  const entries = Object.entries(shader.uniforms).map(([name, handle]) => {
    // An external sampler carries no baked value: the host binds it by slot name at load time
    // (via `fromArtifacts({ textures })` / `applyValues`), so emit only the slot, not a value.
    if (handle.external !== undefined) {
      return `${JSON.stringify(name)}: { type: "sampler2D", external: ${JSON.stringify(handle.external)} }`;
    }
    const type = types.get(name) ?? "float";
    return `${JSON.stringify(name)}: { type: ${JSON.stringify(type)}, value: ${serializeUniformValue(handle.value, name)} }`;
  });
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/** The `FXRenderArtifact` object literal (bare `{ ... }`, for `const <name>: FXRenderArtifact = <body>;`). */
export function renderArtifactBody(
  shader: FXCompiledShader,
  lightingIntrinsics: readonly string[],
  geometry: FXGeometrySource,
  attributes: readonly FXAttributeRequest[],
  renderMode: FXRenderMode,
): string {
  return [
    "{",
    `  lightingIntrinsics: ${JSON.stringify(lightingIntrinsics)},`,
    `  geometry: ${JSON.stringify(geometry)},`,
    `  options: { renderMode: ${JSON.stringify(renderMode)} },`,
    `  uniformDeclarations: ${JSON.stringify(shader.uniformDeclarations)},`,
    `  vertex: ${stageLiteral(shader.vertex)},`,
    `  fragment: ${stageLiteral(shader.fragment)},`,
    `  outputs: ${JSON.stringify(shader.outputs)},`,
    `  uniforms: ${uniformsLiteral(shader)},`,
    `  attributeReads: ${attributeDecls(attributes)},`,
    "}",
  ].join("\n");
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
export function behaviorArtifactBody(
  kernel: FXCompiledKernel,
  attributes: readonly FXAttributeRequest[],
  baseIndent = "",
): string {
  const inner = `${baseIndent}  `;
  const methodBody = `${inner}  `;
  const lines: string[] = [
    "{",
    `${inner}buffers: ${JSON.stringify(kernel.update.buffers)},`,
    `${inner}attributeWrites: ${attributeDecls(attributes)},`,
    `${inner}bindings: ${bindingsLiteral(kernel)},`,
    `${inner}updateWrittenBuffers: ${JSON.stringify(kernel.update.writtenBuffers)},`,
  ];
  if (kernel.spawn !== undefined) {
    lines.push(`${inner}spawnWrittenBuffers: ${JSON.stringify(kernel.spawn.writtenBuffers)},`);
    lines.push(`${inner}spawn(buffers, start, count, bindings, emitter) {`);
    lines.push(indentBody(assembleKernelBody(kernel.spawn, SPAWN_LOOP_HEADER), methodBody));
    lines.push(`${inner}},`);
  }
  lines.push(`${inner}update(buffers, count, dt, bindings, emitter) {`);
  lines.push(indentBody(assembleKernelBody(kernel.update, UPDATE_LOOP_HEADER), methodBody));
  lines.push(`${inner}},`);
  lines.push(`${baseIndent}}`);
  return lines.join("\n");
}

function gpuBindingsLiteral(bindings: Readonly<Record<string, FXKernelBindingHandle>>): string {
  const entries = Object.entries(bindings).map(
    ([name, handle]) =>
      `${JSON.stringify(name)}: { value: ${serializeBindingValue(handle.value)} }`,
  );
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/** The `FXParticleKernelArtifact` object literal (bare `{ ... }`, for `const <name>:
 *  FXParticleKernelArtifact = <body>;`) - the standard-tier (GPU/transform-feedback) sibling of
 *  {@link behaviorArtifactBody}. Unlike the JS artifact, there are no per-phase math helpers to
 *  hoist separately: `program.vertexSource` already carries every GLSL helper inline (the fused
 *  assembler's own doc comment - `FXKernelBuildStandard.Internal.ts`). */
export function gpuKernelArtifactBody(program: FXFusedProgramStandard): string {
  return [
    "{",
    `  vertexSource: ${JSON.stringify(program.vertexSource)},`,
    `  fragmentSource: ${JSON.stringify(program.fragmentSource)},`,
    `  buffers: ${JSON.stringify(program.buffers)},`,
    `  transformFeedbackVaryings: ${JSON.stringify(program.transformFeedbackVaryings)},`,
    `  bindings: ${gpuBindingsLiteral(program.bindings)},`,
    "}",
  ].join("\n");
}
