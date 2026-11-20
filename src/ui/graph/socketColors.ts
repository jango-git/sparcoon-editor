/**
 * Hue per socket type, shared by dots and wires. Red is reserved for error states and is not in the
 * palette.
 */

/** Hue per GLSL socket type; the generic `"T"` and any unknown type share a neutral grey. */
const TYPE_COLORS: Readonly<Record<string, string>> = {
  float: "#4fd1c5", // teal - scalars
  vec2: "#63b3ed", // blue - 2D
  vec3: "#b794f4", // violet - 3D (positions, directions)
  vec4: "#f6ad55", // amber - 4D (colors)
  mat2: "#f687b3", // pink - matrices
  mat3: "#ed94c0",
  mat4: "#e26aad",
  sampler2D: "#68d391", // green - textures
};

/** Neutral color for the generic type variable and anything unmapped. */
const GENERIC_COLOR = "#9aa4b2";

/** The color a socket of `type` is painted (dots, and the wire leaving its output). */
export function socketTypeColor(type: string): string {
  return TYPE_COLORS[type] ?? GENERIC_COLOR;
}
