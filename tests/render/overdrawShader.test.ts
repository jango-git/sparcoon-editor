import { FXMeshMaterial } from "sparcoon/editor";
import type { ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";

import { assembleRenderArtifact } from "../../src/engine/emit/assembleArtifacts";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import { FXCompilerStandard } from "../../src/engine/render/compiler/FXCompilerStandard";
import { FX_MESH_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { overdrawFragmentShader } from "../../src/render/overdrawShader";
import { bind, graphOf } from "../helpers/graphBuild";
import { fullRenderRegistry } from "../helpers/stdRegistry";

const LAYER = "gl_FragColor = vec4(1.0 / 255.0);";
const SHADER = [
  "uniform float cutoff;",
  "void main() {",
  "  vec4 color = vec4(1.0);",
  "  if (color.a < cutoff) discard;",
  "  gl_FragColor = color;",
  "}",
].join("\n");

describe("overdrawFragmentShader", () => {
  it("writes the layer and returns before any discard when counting every fragment", () => {
    const shader = overdrawFragmentShader(SHADER, "rasterized") ?? "";
    const write = shader.indexOf(LAYER);
    expect(write).toBeGreaterThan(shader.indexOf("void main() {"));
    expect(shader.indexOf("return;", write)).toBeLessThan(shader.indexOf("discard;"));
  });

  it("writes the layer last when counting the fragments that survive", () => {
    const shader = overdrawFragmentShader(SHADER, "surviving") ?? "";
    expect(shader.indexOf(LAYER)).toBeGreaterThan(shader.indexOf("gl_FragColor = color;"));
    expect(shader.trimEnd().endsWith(`${LAYER}\n}`)).toBe(true);
    expect(shader).not.toContain("return;");
  });

  it("leaves a shader without a single main alone", () => {
    expect(overdrawFragmentShader("void helper() {}", "rasterized")).toBeUndefined();
    expect(overdrawFragmentShader(`${SHADER}\n${SHADER}`, "surviving")).toBeUndefined();
  });

  describe.each([
    ["baseline", new FXCompilerBaseline()],
    ["standard", new FXCompilerStandard()],
  ] as const)("on a runtime material (%s)", (_tier, compiler) => {
    const reg = fullRenderRegistry();
    const graph = graphOf(
      { col: reg.create("constant", { type: "color", value: [1, 1, 1, 0.5] }) },
      [],
      [bind("albedo", "col", "out")],
    );
    const render = assembleRenderArtifact(
      compiler.compile(graph, FX_MESH_TARGET),
      { type: "primitive", primitive: "plane" },
      [],
      "alphaTest",
    );
    const material = new FXMeshMaterial(render).buildThreeMaterial() as ShaderMaterial;
    const discard = (shader: string): number => shader.lastIndexOf("discard;");

    it("places the write ahead of the alpha cutoff, or after it", () => {
      const rasterized = overdrawFragmentShader(material.fragmentShader, "rasterized") ?? "";
      const surviving = overdrawFragmentShader(material.fragmentShader, "surviving") ?? "";
      expect(discard(rasterized)).toBeGreaterThan(0);
      expect(rasterized.indexOf(LAYER)).toBeLessThan(discard(rasterized));
      expect(surviving.indexOf(LAYER)).toBeGreaterThan(discard(surviving));
    });
  });
});
