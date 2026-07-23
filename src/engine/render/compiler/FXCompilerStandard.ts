import type { FXGraph } from "../../core/FXGraph";
import type { FXRenderNode } from "../FXRenderNode";
import type { FXTarget } from "../target/FXTarget";
import type { FXCompiledShader } from "./FXCompiledShader";
import {
  compileGraphStandard,
  renderNodeKey,
  resolvePlacementStages,
  validateStageDirection,
} from "./FXCompilePipelineStandard.Internal";
import type { FXValidationResult } from "../../core/compiler/FXCompilerError";
import { prepareCompile, throwIfInvalid } from "../../core/compiler/compileDriver.Internal";
import { structuralHash } from "../../core/compiler/FXStructuralHash.Internal";
import { validateGraph } from "../../core/compiler/FXValidation.Internal";
import {
  renderTargetShapeErrors,
  validateRenderTargetSemantics,
} from "../target/FXTargetValidation.Internal";
import { renderTargetSignature } from "../target/FXTargetSignature.Internal";

/**
 * Standard-tier (WebGL2 / GLSL-ES-3.00) twin of {@link FXCompilerBaseline}: turns an
 * {@link FXGraph} into a Three-independent {@link FXCompiledShader}, using the primary `build` of
 * every node (never `baselineBuild`) and the full, unfiltered function registry (including
 * `standardOnly` entries). Independent implementation of the same `validate`/`previewHash`/
 * `compile` contract; nothing here differs from `FXCompilerBaseline` except which compile
 * pipeline `compile` delegates to (validation/hashing have no tier-specific concern today).
 */
export class FXCompilerStandard {
  /**
   * Runs validation only, collecting every problem. Never throws - intended for
   * the editor to surface errors as the user edits.
   */
  public validate(graph: FXGraph<FXRenderNode>, target: FXTarget): FXValidationResult {
    const shapeErrors = renderTargetShapeErrors(target);
    if (shapeErrors.length > 0) {
      return { ok: false, errors: shapeErrors };
    }
    const errors = [
      ...validateRenderTargetSemantics(target),
      ...validateGraph(graph, target).errors,
      ...validateStageDirection(graph, target),
    ];
    return { ok: errors.length === 0, errors };
  }

  /** Structural hash of the graph for `target`, without emitting code. Matches the hash a full
   *  {@link compile} would carry, so the live orchestrator can gate recompile vs. rebind cheaply. */
  public previewHash(graph: FXGraph<FXRenderNode>, target: FXTarget): string {
    const { order, resolution } = prepareCompile(graph);
    const stages = resolvePlacementStages(graph, target, order);
    return structuralHash(
      graph,
      renderTargetSignature(target),
      order,
      renderNodeKey(resolution.types, stages),
    );
  }

  /**
   * Validates then compiles. On an invalid graph {@link throwIfInvalid} throws the first
   * validation error (so the static surface keeps the `code`/`nodeId`); call {@link validate}
   * first when a non-throwing path or the full error list is needed.
   */
  public compile(graph: FXGraph<FXRenderNode>, target: FXTarget): FXCompiledShader {
    throwIfInvalid(this.validate(graph, target));
    return compileGraphStandard(graph, target);
  }
}
