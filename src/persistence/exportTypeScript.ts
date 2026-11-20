/**
 * Exports a project as one TypeScript module: a class extending `sparcoon`'s `FXEffect` that
 * plays the effect given the runtime and the assets its external slots reference. Graphs compile
 * in `exportCompile`, literals are formatted in `exportLiterals`. The runtime is imported
 * (`sparcoon`, `sparcoon/helpers`), never emitted. A lit effect needs a light probe and a
 * directional light in the host scene.
 */

import type { FXGeometrySource, FXRenderMode } from "sparcoon";
import { FX_RUNTIME_VERSION } from "sparcoon/editor";

import { linkReaction, reactionSourceOf } from "../domain/reactionLinking";
import { effectiveSpawnConfig } from "../domain/reactions";
import { STRIP_GEOMETRY } from "../domain/stripChecks";
import type { FXJSHelperName } from "../engine/core/ir/FXHelpers.Internal";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import {
  behaviorArtifactBody,
  collectBehaviorHelpers,
  collectDrawHelpers,
  collectKernelDrawHelpers,
  helpersImportLines,
} from "../engine/emit/artifactLiterals";
import { FXKernelModuleWriter } from "../engine/emit/FXKernelModuleWriter";
import { FXRenderModuleWriter } from "../engine/emit/FXRenderModuleWriter";
import type { Reaction, SourceState } from "../model/editorState";
import { STRIP_NAMES, type StripName } from "../model/graphSlots";
import { libraryAssetNames } from "../model/selectors";
import type { CompiledShadersByGLSLTier } from "./exportCompile";
import { compileEmitter, compileMesh, externalParamNames } from "./exportCompile";
import {
  assertUniqueLiveNames,
  assetsInterface,
  classDeclaration,
  classNameFor,
  type EmitterArtifactNames,
  emitterSpecLiteral,
  importLine,
  meshSpecLiteral,
  needsLiveGetter,
  projectSpecLiteral,
  type RenderArtifactNames,
} from "./exportLiterals";

/** The GLSL tiers every render artifact ships in, in the order their constants are written. */
const RENDER_TIERS = ["baseline", "standard"] as const;

/** The per-tier constant names for one render artifact, e.g. `render0Baseline`/`render0Standard`. */
function tierNames(stem: string): RenderArtifactNames {
  return { baseline: `${stem}Baseline`, standard: `${stem}Standard` };
}

export interface EmitProjectOptions {
  /** Package specifier the emitted module imports the runtime from. @defaultValue `"sparcoon"` */
  readonly importSpecifier?: string;
}

export function emitProjectModule(source: SourceState, options: EmitProjectOptions = {}): string {
  const importSpecifier = options.importSpecifier ?? "sparcoon";
  const className = classNameFor(source.name);

  const jsHelpers = new Set<FXJSHelperName>();
  const importHelpers = (helpers: Iterable<FXJSHelperName>): void => {
    for (const helper of helpers) {
      jsHelpers.add(helper);
    }
  };
  const externalTextureNames = new Set<string>();
  const externalGeometryNames = new Set<string>();
  const externalVolumeNames = new Set<string>();
  const artifactBlocks: string[] = [];
  const emitterSpecs: string[] = [];
  const meshSpecs: string[] = [];
  // True once any emitter actually compiled a GPU kernel (not merely opted in - see
  // compileBehaviorBundle's standardProgram field) - gates the FXParticleKernelArtifact type
  // import so a project with no GPU-driven emitters never imports a type it never uses.
  let needsGpuKernelType = false;
  // One `FXRenderArtifact` constant per GLSL tier, in tier order - an emitter's render and trail
  // and a mesh's render alike.
  const renderWriter = new FXRenderModuleWriter();
  const kernelWriter = new FXKernelModuleWriter();
  const pushRenderArtifacts = (
    names: RenderArtifactNames,
    shaders: CompiledShadersByGLSLTier,
    geometry: FXGeometrySource,
    attributes: readonly FXAttributeRequest[],
    renderMode: FXRenderMode,
  ): void => {
    for (const tier of RENDER_TIERS) {
      importHelpers(collectDrawHelpers(shaders[tier]));
    }
    artifactBlocks.push(
      ...renderWriter.tierDeclarations(
        RENDER_TIERS.map((tier) => ({ name: names[tier], shader: shaders[tier] })),
        geometry,
        attributes,
        renderMode,
      ),
    );
  };

  const collectGeometryName = (geometry: FXGeometrySource): void => {
    if (geometry.type === "custom") {
      externalGeometryNames.add(geometry.external);
    }
  };

  const emitterIndex = new Map(source.scene.emitters.map((emitter, index) => [emitter.id, index]));
  // Compiled first, then linked: a reaction copies what its source's compiled slot holds.
  const compiled = source.scene.emitters.map((emitter) => ({
    emitter,
    ir: compileEmitter(
      emitter,
      effectiveSpawnConfig(emitter, source.scene),
      libraryAssetNames(source),
    ),
  }));
  const reactionSources = new Map(
    compiled.map(({ emitter, ir }) => [emitter.id, reactionSourceOf(ir.kernel)]),
  );
  compiled.forEach(({ emitter, ir }, index) => {
    const inherits = ir.kernel.inherit?.entries ?? [];
    const copiesOf = (reaction: Reaction): readonly number[] =>
      linkReaction(reactionSources.get(reaction.source), reaction.on, inherits).copies;
    importHelpers(collectBehaviorHelpers(ir.kernel));
    const behaviorName = `behavior${String(index)}`;
    let renderNames: RenderArtifactNames | undefined;
    if (ir.drawParticles) {
      renderNames = tierNames(`render${String(index)}`);
      pushRenderArtifacts(renderNames, ir.shaders, ir.geometry, ir.renderAttributes, ir.renderMode);
    }
    artifactBlocks.push(
      `const ${behaviorName}: FXBehaviorArtifact = ${behaviorArtifactBody(ir.kernel)};`,
    );
    let gpuKernelName: string | undefined;
    if (ir.gpuProgram !== undefined) {
      gpuKernelName = `gpuKernel${String(index)}`;
      needsGpuKernelType = true;
      importHelpers(collectKernelDrawHelpers(ir.gpuProgram));
      artifactBlocks.push(...kernelWriter.declarations(gpuKernelName, ir.gpuProgram));
    }
    // Each strip's artifacts, under `trail<index>` / `ribbon<index>`.
    const stripNames = (name: StripName): RenderArtifactNames | undefined => {
      const strip = ir[name];
      if (strip === undefined) {
        return undefined;
      }
      const names = tierNames(`${name}${String(index)}`);
      pushRenderArtifacts(
        names,
        strip.shaders,
        STRIP_GEOMETRY,
        strip.renderAttributes,
        strip.renderMode,
      );
      return names;
    };
    const names: EmitterArtifactNames = {
      ...(renderNames === undefined ? {} : { render: renderNames }),
      ...Object.fromEntries(
        STRIP_NAMES.flatMap((name) => {
          const written = stripNames(name);
          return written === undefined ? [] : [[name, written]];
        }),
      ),
    };
    // One external-slot list per emitter: the textures of every graph it ships, together.
    const slots = [
      ...new Set([
        ...(renderNames === undefined ? [] : externalParamNames(ir.shaders.baseline)),
        ...STRIP_NAMES.flatMap((name) => {
          const strip = ir[name];
          return strip === undefined ? [] : externalParamNames(strip.shaders.baseline);
        }),
      ]),
    ];
    slots.forEach((name) => externalTextureNames.add(name));
    collectGeometryName(ir.geometry);
    ir.sampledAssets.mesh.forEach((name) => externalGeometryNames.add(name));
    ir.sampledAssets.volume.forEach((name) => externalVolumeNames.add(name));
    emitterSpecs.push(
      emitterSpecLiteral(
        emitter,
        names,
        behaviorName,
        ir,
        slots,
        emitterIndex,
        copiesOf,
        gpuKernelName,
      ),
    );
  });

  source.scene.meshes.forEach((mesh, index) => {
    const ir = compileMesh(mesh);
    const renderNames = tierNames(`meshRender${String(index)}`);
    pushRenderArtifacts(renderNames, ir.shaders, ir.geometry, [], ir.renderMode);
    const slots = externalParamNames(ir.shaders.baseline);
    slots.forEach((name) => externalTextureNames.add(name));
    collectGeometryName(ir.geometry);
    meshSpecs.push(meshSpecLiteral(mesh, renderNames, ir, slots));
  });

  assertUniqueLiveNames(source.scene.emitters, "emitter");
  assertUniqueLiveNames(source.scene.meshes, "VFX mesh");

  const specLiteral = projectSpecLiteral(source, emitterSpecs, meshSpecs);
  const assetsBlock = assetsInterface(className, {
    textures: [...externalTextureNames],
    geometries: [...externalGeometryNames],
    volumes: [...externalVolumeNames],
  });
  const needsEmitterType = source.scene.emitters.some(needsLiveGetter);
  const needsMeshType = source.scene.meshes.some(needsLiveGetter);

  const lines: string[] = [];
  // Machine-emitted kernel bodies use untyped plain-JS math helpers; @ts-nocheck/eslint-disable
  // skip checking them in a strict consumer without affecting the exported class/interface types.
  lines.push("// @ts-nocheck");
  lines.push("/* eslint-disable */");
  lines.push("// Generated by the Sparcoon editor. Do not edit by hand.");
  lines.push(`// Built against sparcoon ${FX_RUNTIME_VERSION}.`);
  lines.push(
    importLine(
      importSpecifier,
      needsEmitterType,
      needsGpuKernelType,
      externalTextureNames.size > 0,
    ),
  );
  const threeTypeImports = [
    ...(needsMeshType ? ["type Mesh"] : []),
    ...(externalGeometryNames.size > 0 ? ["type BufferGeometry"] : []),
    ...(externalVolumeNames.size > 0 ? ["type Data3DTexture"] : []),
  ];
  if (threeTypeImports.length > 0) {
    lines.push(`import { ${threeTypeImports.join(", ")} } from "three";`);
  }
  lines.push(
    ...helpersImportLines(importSpecifier, [
      ...jsHelpers,
      ...renderWriter.helperNames(),
      ...kernelWriter.helperNames(),
    ]),
  );
  lines.push("");
  lines.push(...artifactBlocks.map((block) => `${block}\n`));
  lines.push(specLiteral);
  lines.push("");
  lines.push(assetsBlock);
  lines.push("");
  lines.push(classDeclaration(className, source.scene.emitters, source.scene.meshes));
  return lines.join("\n") + "\n";
}
