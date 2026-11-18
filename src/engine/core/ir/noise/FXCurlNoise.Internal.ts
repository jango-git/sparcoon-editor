import type { FXGLSLHelperName } from "../FXHelpers.Internal";
import type { FXFixedOctaves } from "./FXFractalNoise.Internal";

/** The registry function of curl with `octaves` fixed; it takes `(p, lacunarity, gain)`. */
export function fixedCurlName(octaves: FXFixedOctaves): string {
  return `curlOctaves${octaves.toString()}`;
}

export function fixedCurlGLSLName(octaves: FXFixedOctaves): string {
  return `fxCurlOctaves${octaves.toString()}`;
}

export function fixedCurlHelper(octaves: FXFixedOctaves): FXGLSLHelperName {
  return `FX_GLSL_CURL_OCTAVES_${octaves}`;
}
