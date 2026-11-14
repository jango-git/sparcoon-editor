/**
 * The fragment shader of an overdraw variant: the effect's own shader with one line that writes a
 * single layer step, so additive blending sums the layers drawn over each pixel. Where the line
 * goes decides what is counted.
 */

/** What an overdraw view counts per pixel. */
export type OverdrawCount =
  /** Every fragment the quad rasterizes, transparent texels included: the fill cost. */
  | "rasterized"
  /** Only fragments that survive the shader's discards (alpha floor, cutoff, alpha hash). */
  | "surviving";

const MAIN = "void main() {";
// One layer in an 8-bit channel: the blend adds whole steps, so a pixel holds up to 255 layers.
const LAYER = "gl_FragColor = vec4(1.0 / 255.0);";

/**
 * `fragmentShader` with the layer write, or `undefined` when it has no single `main` the write can
 * be placed in. `rasterized` writes and returns at the top of `main`, before any discard;
 * `surviving` writes at its end, after every discard has run.
 */
export function overdrawFragmentShader(
  fragmentShader: string,
  count: OverdrawCount,
): string | undefined {
  const main = fragmentShader.indexOf(MAIN);
  if (main < 0 || fragmentShader.lastIndexOf(MAIN) !== main) {
    return undefined;
  }
  if (count === "rasterized") {
    const body = main + MAIN.length;
    return `${fragmentShader.slice(0, body)}\n${LAYER}\nreturn;${fragmentShader.slice(body)}`;
  }
  // `main` is the shader's last function, so its closing brace is the last one.
  const end = fragmentShader.trimEnd();
  if (!end.endsWith("}")) {
    return undefined;
  }
  return `${end.slice(0, -1)}${LAYER}\n}\n`;
}
