import type { FXAttributeRequest } from "../../core/socket/FXAttribute";
import { FXTargetLiveBackend } from "../../core/live/FXTargetLiveBackend";
import { FXCompilerBaseline } from "../compiler/FXCompilerBaseline";
import { FXCompilerStandard } from "../compiler/FXCompilerStandard";
import type { FXCompiledShader } from "../compiler/FXCompiledShader";
import type { FXGLSLRenderTier } from "../compiler/FXRenderCompilers";
import type { FXRenderNode } from "../FXRenderNode";
import type { FXTarget } from "../target/FXTarget";

/** {@link FXLiveBackend} for the GLSL render backend: validates/hashes/compiles a render graph and
 *  hands the compiled IR to `onInstall`, which the owning material swaps in on a recompile. The
 *  target is derived per snapshot from the graph's own `custom-attribute` requests. */
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
