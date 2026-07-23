/**
 * Exports a whole project as a single, self-contained TypeScript module: a class extending
 * `sparcoon`'s `FXEffect` that plays the effect given only the runtime and the assets its external
 * slots reference. Graphs are compiled headlessly by {@link "./exportCompile"}; the resulting IR is
 * rendered to source text by {@link "./exportLiterals"} - this file is just the orchestrating spine
 * between the two. The generic runtime (base class, sampling math, CPU math/noise helpers) is only
 * imported from `sparcoon`, never re-emitted. A lit effect still needs a light probe + directional
 * light in the consuming scene, since lit graphs read the host scene's lights (studio lighting is
 * not part of the export).
 */

import {
  behaviorArtifactBody,
  collectBehaviorHelpers,
  gpuKernelArtifactBody,
  renderArtifactBody,
} from "../engine/emit/artifactLiterals";
import type { FXGeometrySource } from "sparcoon";
import type { SourceState } from "../model/editorState";
import {
  compileEmitter,
  compileMesh,
  externalParamNames,
  helperImportNames,
} from "./exportCompile";
import {
  assertUniqueLiveNames,
  assetsInterface,
  classDeclaration,
  classNameFor,
  emitterSpecLiteral,
  importLine,
  meshSpecLiteral,
  projectSpecLiteral,
} from "./exportLiterals";

export interface EmitProjectOptions {
  /** Package specifier the emitted module imports the runtime from. @defaultValue `"sparcoon"` */
  readonly importSpecifier?: string;
}

/** Serializes a whole project to a ready-to-import TypeScript effect module (text). */
export function emitProjectModule(source: SourceState, options: EmitProjectOptions = {}): string {
  const importSpecifier = options.importSpecifier ?? "sparcoon";
  const className = classNameFor(source.name);

  const helperNames = new Set<string>();
  const externalTextureNames = new Set<string>();
  const externalGeometryNames = new Set<string>();
  const artifactBlocks: string[] = [];
  const emitterSpecs: string[] = [];
  const meshSpecs: string[] = [];
  // True once any emitter actually compiled a GPU kernel (not merely opted in - see
  // compileBehaviorBundle's standardProgram field) - gates the FXParticleKernelArtifact type
  // import so a project with no GPU-driven emitters never imports a type it never uses.
  let needsGpuKernelType = false;

  const collectGeometryName = (geometry: FXGeometrySource): void => {
    if (geometry.type === "custom") {
      externalGeometryNames.add(geometry.external);
    }
  };

  source.scene.emitters.forEach((emitter, index) => {
    const ir = compileEmitter(emitter);
    for (const helper of collectBehaviorHelpers(ir.kernel)) {
      for (const name of helperImportNames(helper)) {
        helperNames.add(name);
      }
    }
    const renderNames = {
      baseline: `render${String(index)}Baseline`,
      standard: `render${String(index)}Standard`,
    };
    const behaviorName = `behavior${String(index)}`;
    artifactBlocks.push(
      `const ${renderNames.baseline}: FXRenderArtifact = ${renderArtifactBody(
        ir.shaders.baseline,
        ir.lightingIntrinsics,
        ir.geometry,
        ir.renderAttributes,
        ir.renderMode,
      )};`,
    );
    artifactBlocks.push(
      `const ${renderNames.standard}: FXRenderArtifact = ${renderArtifactBody(
        ir.shaders.standard,
        ir.lightingIntrinsics,
        ir.geometry,
        ir.renderAttributes,
        ir.renderMode,
      )};`,
    );
    artifactBlocks.push(
      `const ${behaviorName}: FXBehaviorArtifact = ${behaviorArtifactBody(
        ir.kernel,
        ir.behaviorAttributes,
      )};`,
    );
    let gpuKernelName: string | undefined;
    if (ir.gpuProgram !== undefined) {
      gpuKernelName = `gpuKernel${String(index)}`;
      needsGpuKernelType = true;
      artifactBlocks.push(
        `const ${gpuKernelName}: FXParticleKernelArtifact = ${gpuKernelArtifactBody(ir.gpuProgram)};`,
      );
    }
    const slots = externalParamNames(ir.shaders.baseline);
    slots.forEach((name) => externalTextureNames.add(name));
    collectGeometryName(ir.geometry);
    emitterSpecs.push(
      emitterSpecLiteral(emitter, renderNames, behaviorName, ir, slots, gpuKernelName),
    );
  });

  source.scene.meshes.forEach((mesh, index) => {
    const ir = compileMesh(mesh);
    const renderNames = {
      baseline: `meshRender${String(index)}Baseline`,
      standard: `meshRender${String(index)}Standard`,
    };
    artifactBlocks.push(
      `const ${renderNames.baseline}: FXRenderArtifact = ${renderArtifactBody(
        ir.shaders.baseline,
        ir.lightingIntrinsics,
        ir.geometry,
        [],
        ir.renderMode,
      )};`,
    );
    artifactBlocks.push(
      `const ${renderNames.standard}: FXRenderArtifact = ${renderArtifactBody(
        ir.shaders.standard,
        ir.lightingIntrinsics,
        ir.geometry,
        [],
        ir.renderMode,
      )};`,
    );
    const slots = externalParamNames(ir.shaders.baseline);
    slots.forEach((name) => externalTextureNames.add(name));
    collectGeometryName(ir.geometry);
    meshSpecs.push(meshSpecLiteral(mesh, renderNames, ir, slots));
  });

  assertUniqueLiveNames(source.scene.emitters, "emitter");
  assertUniqueLiveNames(source.scene.meshes, "VFX mesh");

  const specLiteral = projectSpecLiteral(source, emitterSpecs, meshSpecs);
  const assetsBlock = assetsInterface(
    className,
    [...externalTextureNames],
    [...externalGeometryNames],
  );
  const needsEmitterType = source.scene.emitters.some((entity) => entity.liveChannels.length > 0);
  const needsMeshType = source.scene.meshes.some((entity) => entity.liveChannels.length > 0);

  const lines: string[] = [];
  // Machine-emitted kernel bodies use untyped plain-JS math helpers; @ts-nocheck/eslint-disable
  // skip checking them in a strict consumer without affecting the exported class/interface types.
  lines.push("// @ts-nocheck");
  lines.push("/* eslint-disable */");
  lines.push("// Generated by the Sparcoon editor. Do not edit by hand.");
  lines.push(
    importLine(importSpecifier, [...helperNames].sort(), needsEmitterType, needsGpuKernelType),
  );
  const threeTypeImports = [
    "type Texture",
    ...(needsMeshType ? ["type Mesh"] : []),
    ...(externalGeometryNames.size > 0 ? ["type BufferGeometry"] : []),
  ];
  lines.push(`import { ${threeTypeImports.join(", ")} } from "three";`);
  lines.push("");
  lines.push(...artifactBlocks.map((block) => `${block}\n`));
  lines.push(specLiteral);
  lines.push("");
  lines.push(assetsBlock);
  lines.push("");
  lines.push(classDeclaration(className, source.scene.emitters, source.scene.meshes));
  return lines.join("\n") + "\n";
}
