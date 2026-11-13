import type { FXRenderArtifact } from "sparcoon";
import { describe, expect, it } from "vitest";

import { FXRenderModuleWriter } from "../../src/engine/emit/FXRenderModuleWriter";
import { lineDeltaLiteral } from "../../src/engine/emit/lineDelta";
import type { FXCompiledShader } from "../../src/engine/render/compiler/FXCompiledShader";

const PLANE = { type: "primitive", primitive: "plane" } as const;
const HELPER = "float fxSquare(float x){return x*x;}";

/** A compiled shader whose vertex stage runs `vertex` (with the one helper) and fragment `fragment`. */
function shader(vertex: readonly string[], fragment: readonly string[]): FXCompiledShader {
  const stage = (body: readonly string[]) => ({
    uniformDeclarations: [],
    helperFunctions: [HELPER],
    body,
    targetReads: [],
  });
  return {
    uniforms: {},
    color: {
      varyings: [],
      vertex: stage(vertex),
      fragment: stage(fragment),
      outputs: { albedo: "vec4(1.0)" },
    },
    shadow: {
      varyings: [],
      vertex: stage(vertex),
      fragment: stage(fragment.slice(0, 1)),
      outputs: { alpha: "1.0" },
    },
    capabilities: { lightingIntrinsics: [], sceneDepth: false },
    hash: "h",
  };
}

/** Evaluates `declarations` (with the writer's helpers before them) as the module would. */
function evaluate(writer: FXRenderModuleWriter, declarations: readonly string[]) {
  const source = [...writer.helperDeclarations(), ...declarations]
    .join("\n")
    .replaceAll(": FXRenderArtifact", "");
  const names = declarations.map((line) => /^const (\w+)/.exec(line)![1]);
  return new Function(`${source}\nreturn { ${names.join(", ")} };`)() as Record<
    string,
    FXRenderArtifact
  >;
}

const LONG = (index: number) =>
  `float value_${String(index)} = fxSquare(${String(index)}.0) * 2.0;`;

describe("FXRenderModuleWriter", () => {
  it("names the first tier for a later one word for word the same", () => {
    const writer = new FXRenderModuleWriter();
    const declarations = writer.tierDeclarations(
      [
        { name: "aBaseline", shader: shader(["a;"], ["b;"]) },
        { name: "aStandard", shader: shader(["a;"], ["b;"]) },
      ],
      PLANE,
      [],
      "blending",
    );
    expect(declarations[1]).toBe("const aStandard: FXRenderArtifact = aBaseline;");
  });

  it("builds a differing tier from the first one's lines where they agree, line for line", () => {
    const shared = Array.from({ length: 12 }, (_, index) => LONG(index));
    const baseline = shader(shared, ["gl_x = 1.0;"]);
    const standard = shader(
      [...shared.slice(0, 6), "float moved = 3.0;", ...shared.slice(6)],
      ["gl_x = 2.0;"],
    );
    const writer = new FXRenderModuleWriter();
    const declarations = writer.tierDeclarations(
      [
        { name: "rBaseline", shader: baseline },
        { name: "rStandard", shader: standard },
      ],
      PLANE,
      [],
      "blending",
    );
    expect(declarations[1]).toContain("...rBaseline.color.vertex.body.slice(");
    // Each program takes its lines from the same program of the first tier.
    expect(declarations[1]).toContain("...rBaseline.shadow.vertex.body.slice(");
    const artifacts = evaluate(writer, declarations);
    expect(artifacts["rStandard"].shadow?.vertex.body).toEqual(standard.shadow?.vertex.body);
    expect(artifacts["rStandard"].color.vertex.body).toEqual(standard.color.vertex.body);
    expect(artifacts["rStandard"].color.fragment.body).toEqual(standard.color.fragment.body);
    expect(artifacts["rBaseline"].color.vertex.body).toEqual(baseline.color.vertex.body);
  });

  it("declares each distinct helper once for the whole module", () => {
    const writer = new FXRenderModuleWriter();
    const first = writer.tierDeclarations(
      [{ name: "aBaseline", shader: shader(["a;"], ["b;"]) }],
      PLANE,
      [],
      "blending",
    );
    const second = writer.tierDeclarations(
      [{ name: "bBaseline", shader: shader(["c;"], ["d;"]) }],
      PLANE,
      [],
      "blending",
    );
    expect(writer.helperDeclarations()).toEqual([`const glslHelper0 = ${JSON.stringify(HELPER)};`]);
    const artifacts = evaluate(writer, [...first, ...second]);
    expect(artifacts["bBaseline"].color.fragment.helperFunctions).toEqual([HELPER]);
  });
});

describe("lineDeltaLiteral", () => {
  it("writes short shared runs out: a slice would cost more", () => {
    expect(lineDeltaLiteral(["a;", "b;"], ["a;", "b;"], "base")).toBe('["a;", "b;"]');
  });
});
