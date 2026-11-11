import type { FXHelperModule } from "../FXHelperModule.Internal";
import {
  glslOctaveSumUnrolled,
  jsNormalized,
  jsOctaveLoop,
  type FXFixedOctaves,
} from "./FXFractalNoise.Internal";
import { jsMemoized } from "./FXNoiseJSMemo.Internal";
import { FX_JS_NOISED } from "./FXValueNoise.Internal";

/**
 * Curl noise from analytic gradients, octaves summed like fBm:
 * - 2D: (dpsi/dy, -dpsi/dx) of psi = noise(p);
 * - 3D: curl of (psi1, psi2, psi3) = noise at p, p + PSI_2_OFFSET, p + PSI_3_OFFSET.
 */

type Vector3 = readonly [number, number, number];
const PSI_2_OFFSET: Vector3 = [31.416, 12.703, 5.906];
const PSI_3_OFFSET: Vector3 = [-43.28, 27.13, -19.87];

const glslOffset = (offset: Vector3): string => `vec3(${offset.join(",")})`;
const jsOffset = ([ox, oy, oz]: Vector3): string =>
  `x+(${ox.toString()}),y+(${oy.toString()}),z+(${oz.toString()})`;

const CURL_SAMPLES = {
  vec2: "vec3 d=fxNoised(p);sum+=vec2(d.z,-d.y)*amp;",
  vec3:
    "vec3 g1=fxNoised(p).yzw;" +
    `vec3 g2=fxNoised(p+${glslOffset(PSI_2_OFFSET)}).yzw;` +
    `vec3 g3=fxNoised(p+${glslOffset(PSI_3_OFFSET)}).yzw;` +
    "sum+=vec3(g3.y-g2.z,g1.z-g3.x,g2.x-g1.y)*amp;",
} as const;

/** The registry function of curl with `octaves` fixed; it takes `(p, lacunarity, gain)`. */
export function fixedCurlName(octaves: FXFixedOctaves): string {
  return `curlOctaves${octaves.toString()}`;
}

export function fixedCurlGLSLName(octaves: FXFixedOctaves): string {
  return `fxCurlOctaves${octaves.toString()}`;
}

/** The unrolled curl module over a tier's `fxNoised` module (curl only ever has a fixed count). */
export function glslFixedCurlModule(
  noised: FXHelperModule,
  octaves: FXFixedOctaves,
): FXHelperModule {
  const name = fixedCurlGLSLName(octaves);
  const overloads = (["vec2", "vec3"] as const).map((type) =>
    glslOctaveSumUnrolled(
      `${type} ${name}(${type} p,float lacunarity,float gain)`,
      type,
      CURL_SAMPLES[type],
      octaves,
    ),
  );
  return { key: fixedCurlName(octaves), source: `\n${overloads.join("\n")}`, requires: [noised] };
}

const JS_CURL_2 = jsMemoized(
  "fxCurl2",
  ["x", "y", "o", "l", "g"],
  2,
  "var sx=0,sy=0;" +
    jsOctaveLoop(["x", "y"], "fxNoised2(x,y);sx+=fxNd2*amp;sy-=fxNd1*amp;") +
    `r[0]=${jsNormalized("sx")};r[1]=${jsNormalized("sy")};`,
);

const JS_CURL_3 = jsMemoized(
  "fxCurl3",
  ["x", "y", "z", "o", "l", "g"],
  3,
  "var sx=0,sy=0,sz=0;" +
    jsOctaveLoop(
      ["x", "y", "z"],
      "fxNoised3(x,y,z);var a2=fxNd2,a3=fxNd3;" +
        `fxNoised3(${jsOffset(PSI_2_OFFSET)});var b1=fxNd1,b3=fxNd3;` +
        `fxNoised3(${jsOffset(PSI_3_OFFSET)});var c1=fxNd1,c2=fxNd2;` +
        "sx+=(c2-b3)*amp;sy+=(a3-c1)*amp;sz+=(b1-a2)*amp;",
    ) +
    `r[0]=${jsNormalized("sx")};r[1]=${jsNormalized("sy")};r[2]=${jsNormalized("sz")};`,
);

export const FX_JS_CURL: FXHelperModule = {
  key: "curl",
  requires: [FX_JS_NOISED],
  source: `\n${JS_CURL_2}\n${JS_CURL_3}`,
};
