/**
 * Which GLSL render tier (see `../engine/render/compiler/FXRenderCompilers`) the editor's own live
 * preview compiles/renders with. Reload-based, not live-applied: switching tiers changes both the
 * WebGL context (`sceneCoordinator.ts`) and the compiler feeding the live graphs
 * (`FXRenderLiveBackend`), and neither `structuralHash`/`previewHash` nor `FXLiveGraph`'s cache
 * key on which tier produced a compiled artifact - a live in-place switch could silently keep
 * serving a stale shader. A full reload sidesteps that entirely: every live graph rebuilds from an
 * empty cache, so there is nothing to keep in sync.
 */

import { readString, writeString } from "../util/storage";
import type { FXGLSLRenderTier } from "../engine/render/compiler/FXRenderCompilers";

const STORAGE_KEY = "sparcoon-editor.renderBackend";

/** The persisted choice, or the browser's own negotiated capability when never set. */
export function detectRenderBackend(): FXGLSLRenderTier {
  const stored = readString(STORAGE_KEY);
  if (stored === "baseline" || stored === "standard") {
    return stored;
  }
  return "standard";
}

/**
 * Persists `tier` and reloads so every layer that reads it (the WebGL context, the live
 * compiler) picks it up from a clean start. A no-op if the choice is unchanged or storage
 * rejects the write (private mode, full quota) - never reloads without actually persisting.
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
 * Reverts a forced choice that failed to actually apply (the browser could not create the
 * requested WebGL context) back to the default, without reloading - the caller is already
 * running degraded on whatever context it fell back to, so a reload would only repeat the same
 * failure. Silent by design if storage rejects the write; the in-memory session already
 * degraded correctly, only the *next* reload's starting point is affected.
 */
export function resetRenderBackend(): void {
  writeString(STORAGE_KEY, "standard");
}
