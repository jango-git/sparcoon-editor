import type { FXBehaviorArtifact, FXRenderArtifact } from "sparcoon";
import * as sparcoon from "sparcoon";
import * as sparcoonHelpers from "sparcoon/helpers";

import { loadModule } from "./loadModule";

/** The three artifacts an `emitEffectModule` module exports. */
export interface EffectModuleExports {
  readonly renderBaseline: FXRenderArtifact;
  readonly renderStandard: FXRenderArtifact;
  readonly behavior: FXBehaviorArtifact;
}

/** Evaluates an emitted effect module's text, with `sparcoon` and its helpers its only imports. */
export function evaluateEffectModule(text: string): EffectModuleExports {
  return loadModule(text, {
    sparcoon,
    "sparcoon/helpers": sparcoonHelpers,
  }) as unknown as EffectModuleExports;
}
