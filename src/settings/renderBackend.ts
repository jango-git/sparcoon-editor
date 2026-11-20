/**
 * The GLSL render tier the live preview uses. A change persists and reloads the page: the tier
 * decides the WebGL context and the compiler, and neither the shader hashes nor `FXLiveGraph`'s
 * cache key on it, so a live switch could keep serving a stale shader.
 */

import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";
import { readString, writeString } from "../util/storage";

const STORAGE_KEY = "sparcoon-editor.renderBackend";

/** The persisted choice, `standard` when none is stored. */
export function detectRenderBackend(): FXGLSLRenderTier {
  const stored = readString(STORAGE_KEY);
  if (stored === "baseline" || stored === "standard") {
    return stored;
  }
  return "standard";
}

/**
 * Persists `tier` and reloads. Does nothing when the choice is unchanged or storage rejects the
 * write (private mode, full quota).
 */
export function setRenderBackend(tier: FXGLSLRenderTier): void {
  if (tier === detectRenderBackend()) {
    return;
  }
  if (!writeString(STORAGE_KEY, tier)) {
    return;
  }
  location.reload();
}

/**
 * Resets a forced choice the browser could not apply (no such WebGL context) to the default,
 * without reloading: the session already runs on the fallback context. A rejected storage write
 * is ignored.
 */
export function resetRenderBackend(): void {
  writeString(STORAGE_KEY, "standard");
}
