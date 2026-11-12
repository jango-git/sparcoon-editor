import type { FXBehaviorArtifact, FXRenderArtifact } from "sparcoon";
import * as sparcoon from "sparcoon";

import { loadModule } from "./loadModule";

/** The three artifacts an `emitEffectModule` module exports. */
export interface EffectModuleExports {
  readonly renderBaseline: FXRenderArtifact;
  readonly renderStandard: FXRenderArtifact;
  readonly behavior: FXBehaviorArtifact;
}

/** Evaluates an emitted effect module's text, with `sparcoon` as its only resolvable import. */
export function evaluateEffectModule(text: string): EffectModuleExports {
  return loadModule(text, { sparcoon }) as unknown as EffectModuleExports;
}
