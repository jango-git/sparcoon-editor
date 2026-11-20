import { FXTargetLiveBackend } from "../../core/live/FXTargetLiveBackend";
import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import type { FXCompiledShader } from "../compiler/FXCompiledShader";
import { FXCompilerBaseline } from "../compiler/FXCompilerBaseline";
import { FXCompilerStandard } from "../compiler/FXCompilerStandard";
import type { FXGLSLRenderTier } from "../compiler/FXRenderCompilers";
import type { FXRenderNode } from "../FXRenderNode";
import type { FXTarget } from "../target/FXTarget";

export class FXRenderLiveBackend extends FXTargetLiveBackend<
  FXRenderNode,
  FXCompiledShader,
  FXTarget
> {
  constructor(
    renderBackend: FXGLSLRenderTier,
    buildTarget: (attributes: readonly FXAttributeRequest[]) => FXTarget,
    onInstall: (compiled: FXCompiledShader) => void,
  ) {
    const compiler =
      renderBackend === "standard" ? new FXCompilerStandard() : new FXCompilerBaseline();
    super({
      buildTarget,
      validate: (graph, target) => compiler.validate(graph, target),
      previewHash: (graph, target) => compiler.previewHash(graph, target),
      compile: (graph, target) => compiler.compile(graph, target),
      install: onInstall,
    });
  }
}
