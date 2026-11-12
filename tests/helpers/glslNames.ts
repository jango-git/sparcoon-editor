import type { FXCompiledShader } from "../../src/engine/render/compiler/FXCompiledShader";

/** A generated GLSL name (`_0`, `_1a`), as a regex source to compose into a pattern. */
export const GLSL_NAME = "_[0-9a-z]+";

/** The uniforms `shader`'s draw stage fills: the ones its `compute` writes. */
export function drawUniformNames(shader: FXCompiledShader): string[] {
  const statements = shader.draw?.statements.join("\n") ?? "";
  return [...new Set([...statements.matchAll(/uniforms\["(\w+)"\]/g)].map((match) => match[1]))];
}

/** Whether `source` reads the identifier `name` (not merely a longer name that starts with it). */
export function readsName(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source);
}
