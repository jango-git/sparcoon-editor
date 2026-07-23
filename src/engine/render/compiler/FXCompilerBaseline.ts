import type { FXGraph } from "../../core/FXGraph";
import type { FXRenderNode } from "../FXRenderNode";
import type { FXTarget } from "../target/FXTarget";
import type { FXCompiledShader } from "./FXCompiledShader";
import {
  compileGraphBaseline,
  renderNodeKey,
  resolvePlacementStages,
  validateStageDirection,
} from "./FXCompilePipelineBaseline.Internal";
import type { FXValidationResult } from "../../core/compiler/FXCompilerError";
import { prepareCompile, throwIfInvalid } from "../../core/compiler/compileDriver.Internal";
import { structuralHash } from "../../core/compiler/FXStructuralHash.Internal";
import { validateGraph } from "../../core/compiler/FXValidation.Internal";
import {
  renderTargetShapeErrors,
  validateRenderTargetSemantics,
} from "../target/FXTargetValidation.Internal";
import { renderTargetSignature } from "../target/FXTargetSignature.Internal";

/** Turns an {@link FXGraph} into a Three-independent {@link FXCompiledShader} for a given
 *  {@link FXTarget}: validate, topo-sort, build each node through a context, then assemble. */
export class FXCompilerBaseline {
  /**
   * Runs validation only, collecting every problem. Never throws - intended for
   * the editor to surface errors as the user edits.
   */
  public validate(graph: FXGraph<FXRenderNode>, target: FXTarget): FXValidationResult {
    // The target is host-provided data; a structurally malformed literal (missing
    // `inputs`, a non-array, junk field types) fails fast here - the graph
    // validators below dereference the target and would TypeError on it.
    const shapeErrors = renderTargetShapeErrors(target);
    if (shapeErrors.length > 0) {
      return { ok: false, errors: shapeErrors };
    }
    // Then lint its semantics (shape already checked above, so use the shape-free
    // variant), so a malformed input name/stage surfaces as a structured error
    // rather than a broken Three shader downstream.
    const errors = [
      ...validateRenderTargetSemantics(target),
      ...validateGraph(graph, target).errors,
      // Stage direction is a render-backend concern (vertex->fragment promotion),
      // kept out of the backend-agnostic graph validator.
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
    return compileGraphBaseline(graph, target);
  }
}
