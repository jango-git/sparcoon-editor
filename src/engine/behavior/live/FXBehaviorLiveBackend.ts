import { FXTargetLiveBackend } from "../../core/live/FXTargetLiveBackend";
import type { FXBehaviorNode } from "../FXBehaviorNode";
import type { FXCompiledBehaviorBundle } from "../FXCompiledBehaviorBundle";
import { compileBehaviorBundle } from "../FXCompiledBehaviorBundle";
import { previewBehaviorHash, validateBehavior } from "../FXParticleBehaviorKernel.Internal";
import type { FXBehaviorTargetFactory, FXBehaviorTargets } from "../FXParticleBehaviorTarget";

/**
 * {@link FXLiveBackend} for the behavior backend: validates/hashes/compiles a behavior graph and
 * hands the compiled bundle (the mandatory JS kernel plus any optional simulation family that
 * compiled - see {@link FXCompiledBehaviorBundle}) to `onInstall` to hot-swap the running
 * simulation's spawn/update kernels - particle state buffers are never touched, so live particles
 * survive. Phase targets are derived per snapshot from the graph's own `store-attribute` requests
 * through the injected {@link FXBehaviorTargetFactory} (so a host can drive its own target
 * scheme); {@link FXTargetLiveBackend} owns the shared attribute-collection/derivation plumbing.
 */
export class FXBehaviorLiveBackend extends FXTargetLiveBackend<
  FXBehaviorNode,
  FXCompiledBehaviorBundle,
  FXBehaviorTargets
> {
  constructor(
    onInstall: (compiled: FXCompiledBehaviorBundle) => void,
    buildTargets: FXBehaviorTargetFactory,
  ) {
    super({
      buildTarget: buildTargets,
      validate: validateBehavior,
      previewHash: previewBehaviorHash,
      compile: compileBehaviorBundle,
      install: onInstall,
    });
  }
}
