import { describe, expect, it } from "vitest";

import { isFXCompilerErrorException } from "../../src/engine/core/compiler/FXCompilerError";
import type { FXConnection } from "../../src/engine/core/FXGraph";
import { FXGraph } from "../../src/engine/core/FXGraph";
import { TEXTURE_META } from "../../src/engine/nodes-std/manualNodeMetas";
import type { FXCompiledShader } from "../../src/engine/render/compiler/FXCompiledShader";
import { FX_GLSL_RENDER_COMPILERS } from "../../src/engine/render/compiler/FXRenderCompilers";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { registerManualRenderNodes } from "../../src/engine/render/nodes/FXManualRenderNodes";
import { FXRenderNodeTexture } from "../../src/engine/render/nodes/FXRenderNodeTexture";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { renderRegistry } from "../helpers/stdRegistry";

// The std registry plus the hand-written nodes, so "texture" goes through its real factory.
const reg = renderRegistry();
registerManualRenderNodes(reg);

function edge(fromNode: string, fromKey: string, toNode: string, toKey: string): FXConnection {
  return {
    from: { nodeId: fromNode, socketKey: fromKey },
    to: { nodeId: toNode, socketKey: toKey },
  };
}

/** UV -> Texture(wrap) -> albedo, compiled on `tier`; returns the fragment body as one string. */
function fragmentOf(wrap: unknown, tier: keyof typeof FX_GLSL_RENDER_COMPILERS): string {
  const graph = new FXGraph<FXRenderNode>();
  graph.ingest({
    nodes: new Map<string, FXRenderNode>([
      ["uv", reg.create("uv", {})],
      ["tex", reg.create("texture", { name: "sheet", wrap })],
    ]),
    connections: [edge("uv", "uv", "tex", "uv")],
    outputBindings: [{ slot: "albedo", from: { nodeId: "tex", socketKey: "color" } }],
  });
  const shader: FXCompiledShader = FX_GLSL_RENDER_COMPILERS[tier].compile(
    graph,
    FX_PARTICLE_TARGET,
  );
  return shader.fragment.body.join("\n");
}

describe("texture wrap", () => {
  for (const tier of ["baseline", "standard"] as const) {
    describe(tier, () => {
      it("clamp (and an absent wrap, as in a project saved before the param) adds no UV math", () => {
        for (const wrap of ["clamp", undefined]) {
          const body = fragmentOf(wrap, tier);
          expect(body).toContain("fxSample_u_param_sheet(");
          expect(body).not.toMatch(/fract\(|mod\(|step\(/);
        }
      });

      it("repeat tiles the UV with fract", () => {
        expect(fragmentOf("repeat", tier)).toMatch(/fxSample_u_param_sheet\([^;]*fract\(/s);
      });

      it("mirror folds the UV with mod and abs", () => {
        const body = fragmentOf("mirror", tier);
        expect(body).toContain("mod(");
        expect(body).toContain("abs(");
      });

      it("border masks the sample with step", () => {
        const body = fragmentOf("border", tier);
        expect(body).toContain("step(");
        expect(body.match(/fxSample_u_param_sheet\(/g)).toHaveLength(1);
      });
    });
  }

  it("declares the param in the palette meta with clamp as the default", () => {
    expect(TEXTURE_META.params["wrap"]).toEqual({
      kind: "structural",
      type: "enum",
      options: ["clamp", "repeat", "mirror", "border"],
      default: "clamp",
    });
  });

  it("changes the cache key, so switching modes recompiles", () => {
    const node = new FXRenderNodeTexture("sheet");
    const clampKey = node.cacheKey();
    node.applyParams({ name: "sheet", wrap: "repeat" });
    expect(node.cacheKey()).not.toBe(clampKey);
    // A snapshot without the key resets to the default, like any structural param.
    node.applyParams({ name: "sheet" });
    expect(node.cacheKey()).toBe(clampKey);
  });

  it("costs the fetch plus the mode's UV math", () => {
    const costs = ["clamp", "repeat", "mirror", "border"].map((wrap) =>
      new FXRenderNodeTexture("sheet", wrap).estimateCost(),
    );
    expect(costs[0]).toBe(TEXTURE_META.cost);
    expect(costs[1]).toBeGreaterThan(costs[0] ?? 0);
    expect(new FXRenderNodeTexture("", "border").estimateCost()).toBe(0);
  });

  it("rejects an unknown mode as bad-enum-value", () => {
    let caught: unknown;
    try {
      new FXRenderNodeTexture("sheet", "wrap-around");
    } catch (error) {
      caught = error;
    }
    expect(isFXCompilerErrorException(caught)).toBe(true);
    if (isFXCompilerErrorException(caught)) {
      expect(caught.error.code).toBe("bad-enum-value");
    }
  });
});
