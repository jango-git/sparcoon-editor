/**
 * The overdraw view's heat ramp: the colors of its stops by layer count, and the full-screen quad
 * that paints a counts texture with them. The viewport's legend draws the same stops.
 */

import {
  type Camera,
  type IUniform,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  type Texture,
  type WebGLRenderer,
} from "three";

/** A ramp stop: its layer count and color. The ramp blends between stops on a log2 scale. */
export interface OverdrawRampStop {
  readonly layers: number;
  readonly color: string;
}

/** From no layer (black) to the last stop; a count past it shows the last stop's color. */
export const OVERDRAW_RAMP: readonly OverdrawRampStop[] = [
  { layers: 0, color: "#000000" },
  { layers: 1, color: "#1d2b8f" },
  { layers: 2, color: "#2f6fe0" },
  { layers: 4, color: "#2fbf5a" },
  { layers: 8, color: "#f2d23c" },
  { layers: 16, color: "#e8452c" },
  { layers: 32, color: "#ffffff" },
];

function glslColor(hex: string): string {
  const channel = (offset: number): string =>
    (Number.parseInt(hex.slice(offset, offset + 2), 16) / 255).toFixed(4);
  return `vec3(${channel(1)}, ${channel(3)}, ${channel(5)})`;
}

// Stop k sits at s = k: s is 0 for no layer and log2(count) + 1 for one or more, which puts
// 1, 2, 4, ... layers on stops 1, 2, 3, ...
const [NONE, ...STOPS] = OVERDRAW_RAMP;
const FRAGMENT = [
  "uniform sampler2D counts;",
  "varying vec2 vUv;",
  "void main() {",
  "  float count = floor(texture2D(counts, vUv).r * 255.0 + 0.5);",
  "  float s = count < 0.5 ? 0.0 : log2(count) + 1.0;",
  `  vec3 color = ${glslColor(NONE?.color ?? "#000000")};`,
  ...STOPS.map(
    (stop, index) =>
      `  color = mix(color, ${glslColor(stop.color)}, clamp(s - ${index.toFixed(1)}, 0.0, 1.0));`,
  ),
  "  gl_FragColor = vec4(color, 1.0);",
  "}",
].join("\n");

const VERTEX = [
  "varying vec2 vUv;",
  "void main() {",
  "  vUv = uv;",
  "  gl_Position = vec4(position.xy, 0.0, 1.0);",
  "}",
].join("\n");

/** The ramp drawn over the whole current target, painting a counts texture (one layer per 1/255). */
export class OverdrawRamp {
  // Unset until the first draw: three binds an empty texture for a missing value.
  private readonly counts: IUniform<Texture | undefined> = { value: undefined };
  private readonly mesh = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      name: "OverdrawRamp",
      uniforms: { counts: this.counts },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );

  constructor() {
    this.mesh.frustumCulled = false;
  }

  public draw(renderer: WebGLRenderer, camera: Camera, counts: Texture): void {
    this.counts.value = counts;
    renderer.render(this.mesh, camera);
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
