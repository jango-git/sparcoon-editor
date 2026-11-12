import { describe, expect, it } from "vitest";
import type { FXFusedProgramStandard } from "../../src/engine/behavior/FXKernelBuildStandard.Internal";
import { FXKernelModuleWriter } from "../../src/engine/emit/FXKernelModuleWriter";

const HEAD = Array.from(
  { length: 10 },
  (_, index) => `uniform float u_fxContract${String(index)};`,
);

function program(body: readonly string[]): FXFusedProgramStandard {
  return {
    vertexSource: ["#version 300 es", ...HEAD, "void main(){", ...body, "}"].join("\n"),
    fragmentSource: "#version 300 es\nvoid main(){}\n",
    transformFeedbackVaryings: ["out_position"],
    buffers: [{ name: "position", stride: 3 }],
    bindings: {},
  };
}

describe("FXKernelModuleWriter", () => {
  it("joins each kernel's source from lines it shares with an earlier one, source for source", () => {
    const first = program(["  out_position = in_position;"]);
    const second = program(["  out_position = in_position * 2.0;"]);
    const writer = new FXKernelModuleWriter();
    const declarations = [
      ...writer.declarations("gpuKernel0", first),
      ...writer.declarations("gpuKernel1", second),
    ];
    expect(declarations.join("\n")).toContain("...gpuKernel0Lines.slice(");
    expect(declarations.join("\n")).toContain("fragmentSource: gpuKernel0.fragmentSource");
    const source = declarations.join("\n").replaceAll(": FXParticleKernelArtifact", "");
    const kernels = new Function(`${source}\nreturn [gpuKernel0, gpuKernel1];`)() as {
      vertexSource: string;
      fragmentSource: string;
    }[];
    expect(kernels[0].vertexSource).toBe(first.vertexSource);
    expect(kernels[1].vertexSource).toBe(second.vertexSource);
    expect(kernels[1].fragmentSource).toBe(second.fragmentSource);
  });
});
