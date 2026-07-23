import type { FXRenderArtifact } from "sparcoon";
import { paramUniformName } from "../engine/nodes-std/paramSupport.Internal";

/** The `u_param_` prefix an external sampler slot carries; stripped to recover the param name. */
export const PARAM_SLOT_PREFIX = paramUniformName("");

/** One external sampler slot in a render artifact: its uniform name and the texture it references. */
export interface ExternalSlot {
  readonly uniformName: string;
  readonly paramName: string;
}

/** The external sampler slots (Textures) a render artifact declares, with their param names. */
export function externalSlots(render: FXRenderArtifact): readonly ExternalSlot[] {
  const slots: ExternalSlot[] = [];
  for (const [name, init] of Object.entries(render.uniforms)) {
    if ("external" in init && typeof init.external === "string") {
      slots.push({ uniformName: name, paramName: init.external.slice(PARAM_SLOT_PREFIX.length) });
    }
  }
  return slots;
}
