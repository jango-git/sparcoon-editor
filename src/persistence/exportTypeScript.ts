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

import { effectiveSpawnConfig } from "../domain/deathReactions";
import {
  behaviorArtifactBody,
  collectBehaviorHelpers,
  gpuKernelArtifactBody,
  renderArtifactBody,
  renderArtifactDeclarations,
} from "../engine/emit/artifactLiterals";
import type { FXGeometrySource } from "sparcoon";
import type { SourceState } from "../model/editorState";
import { TRAIL_GEOMETRY } from "../domain/trailChecks";
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
  // One `FXRenderArtifact` constant per GLSL tier, in tier order - an emitter's render and trail
  // and a mesh's render alike.
  const pushRenderArtifacts = (
    names: RenderArtifactNames,
    body: (tier: keyof RenderArtifactNames) => string,
  ): void => {
    artifactBlocks.push(
      ...renderArtifactDeclarations(
        RENDER_TIERS.map((tier) => ({ name: names[tier], body: body(tier) })),
      ),
    );
  };

  const collectGeometryName = (geometry: FXGeometrySource): void => {
    if (geometry.type === "custom") {
      externalGeometryNames.add(geometry.external);
    }
  };

  const emitterIndex = new Map(source.scene.emitters.map((emitter, index) => [emitter.id, index]));
  source.scene.emitters.forEach((emitter, index) => {
    const ir = compileEmitter(emitter, effectiveSpawnConfig(emitter, source.scene));
    for (const helper of collectBehaviorHelpers(ir.kernel)) {
      for (const name of helperImportNames(helper)) {
        helperNames.add(name);
      }
    }
    const renderNames = tierNames(`render${String(index)}`);
    const behaviorName = `behavior${String(index)}`;
    pushRenderArtifacts(renderNames, (tier) =>
      renderArtifactBody(
        ir.shaders[tier],
        ir.lightingIntrinsics,
        ir.geometry,
        ir.renderAttributes,
        ir.renderMode,
      ),
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
    let trailNames: RenderArtifactNames | undefined;
    if (ir.trail !== undefined) {
      const trail = ir.trail;
      trailNames = tierNames(`trail${String(index)}`);
      pushRenderArtifacts(trailNames, (tier) =>
        renderArtifactBody(
          trail.shaders[tier],
          [],
          TRAIL_GEOMETRY,
          trail.renderAttributes,
          trail.renderMode,
        ),
      );
    }
    // One external-slot list per emitter: its particles' and its trail's textures together.
    const slots = [
      ...new Set([
        ...externalParamNames(ir.shaders.baseline),
        ...(ir.trail === undefined ? [] : externalParamNames(ir.trail.shaders.baseline)),
      ]),
    ];
    slots.forEach((name) => externalTextureNames.add(name));
    collectGeometryName(ir.geometry);
    emitterSpecs.push(
      emitterSpecLiteral(
        emitter,
        renderNames,
        behaviorName,
        ir,
        slots,
        emitterIndex,
        gpuKernelName,
        trailNames,
      ),
    );
  });

  source.scene.meshes.forEach((mesh, index) => {
    const ir = compileMesh(mesh);
    const renderNames = tierNames(`meshRender${String(index)}`);
    pushRenderArtifacts(renderNames, (tier) =>
      renderArtifactBody(ir.shaders[tier], ir.lightingIntrinsics, ir.geometry, [], ir.renderMode),
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
  const needsEmitterType = source.scene.emitters.some(needsLiveGetter);
  const needsMeshType = source.scene.meshes.some(needsLiveGetter);

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
