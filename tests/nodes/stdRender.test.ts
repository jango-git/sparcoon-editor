import { describe, expect, it } from "vitest";
import { FX_RENDER_CONTENT_NODES } from "../../src/engine/nodes-std/render/content";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXCompiledShader } from "../../src/engine/render/compiler/FXCompiledShader";
import { literalGenericType } from "../../src/engine/core/socket/FXValueType";
import {
  FX_MESH_TARGET,
  FX_PARTICLE_TARGET,
} from "../../src/engine/render/target/FXParticleRenderTarget";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { renderRegistry } from "../helpers/stdRegistry";
import { GLSL_NAME, drawUniformNames } from "../helpers/glslNames";

const reg = renderRegistry();
const white = (): FXRenderNode => reg.create("constant", { type: "color", value: [1, 1, 1, 1] });

const compiler = new FXCompilerBaseline();

/** Fragment helpers + body of a graph that feeds `node.socketKey` to `alphaThreshold`. */
/**
 * Both stages' bodies as one text, each value the vertex stage carries across read in the
 * fragment under the local it was computed as - the program as written, wherever the compiler
 * placed each part of it.
 */
function programText(shader: FXCompiledShader): string {
  let fragment = shader.fragment.body.join("\n");
  for (const write of shader.vertex.body) {
    // RegExp#exec is the external API that demands null; converted once here at the boundary.
    const carried = /^(v_bridge_\w+) = (\w+);$/.exec(write) ?? undefined;
    const varying = carried?.[1];
    const source = carried?.[2];
    if (varying !== undefined && source !== undefined) {
      fragment = fragment.replaceAll(new RegExp(`\\b${varying}\\b`, "g"), source);
    }
  }
  return `${shader.vertex.body.join("\n")}\n${fragment}`;
}

function fragmentOf(
  node: FXRenderNode,
  socketKey: string,
  target: Parameters<FXCompilerBaseline["compile"]>[1] = FX_PARTICLE_TARGET,
): string {
  const graph = graphOf(
    { n: node, c: white() },
    [],
    [bind("albedo", "c", "out"), bind("alphaThreshold", "n", socketKey)],
  );
  const stage = compiler.compile(graph, target).fragment;
  return [...stage.helperFunctions, ...stage.body].join("\n");
}

describe("standard render nodes - sources and content", () => {
  it("color inlines its albedo as a literal (a constant spends no uniform slot)", () => {
    const graph = graphOf(
      { c: reg.create("constant", { type: "color", value: [0.2, 0.4, 0.6, 1] }) },
      [],
      [bind("albedo", "c", "out")],
    );
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(shader.outputs["albedo"]).toBeDefined();
    // A constant color bakes inline; only param nodes allocate uniforms.
    expect(Object.keys(shader.uniforms)).toHaveLength(0);
    const src = shader.fragment.body.join("\n") + JSON.stringify(shader.outputs);
    expect(src).toContain("0.2");
  });

  it("animated-texture is driven by a ratio input, reading only the UV it offsets", () => {
    const anim = reg.create("animated-texture", { columns: 4, rows: 4 });
    // It maps a normalized `ratio` input to the current flipbook cell - no age/lifetime read of
    // its own; it only reads the UV it offsets (via its `uv` default).
    expect(anim.targetReads).not.toContain("PARTICLE_AGE");
    expect(anim.targetReads).not.toContain("PARTICLE_LIFETIME");
    expect(anim.targetReads).toContain("p_uv");
  });

  // The flipbook helpers are raw GLSL with no CPU twin, so the emitted text is the observable:
  // these pin only the token that distinguishes each mode.
  it("animated-texture plays once through by default, looping only when asked", () => {
    // Once through clamps the ratio (the last frame holds); looping wraps it with fract.
    const once = fragmentOf(reg.create("animated-texture", { columns: 4, rows: 4 }), "factor");
    expect(once).toContain("clamp(ratio");
    expect(once).not.toContain("fract(");
    const looping = fragmentOf(
      reg.create("animated-texture", { columns: 4, rows: 4, loop: true }),
      "factor",
    );
    expect(looping).toContain("fract(ratio)");
  });

  it("animated-texture runs over Frames when set, else every cell, mapped without mod", () => {
    const code = fragmentOf(
      reg.create("animated-texture", { columns: 5, rows: 5, frames: 23 }),
      "factor",
    );
    // The frame count selects Frames above 0, else columns * rows.
    expect(code).toMatch(/> 0\.5 \? floor\(/);
    // The column comes off the row, never a mod that may land a cell off at a row's end.
    expect(code).not.toContain("mod(");
  });

  it("flipbook-frame picks a cell by number, wrapped without mod and with no cross-fade", () => {
    const graph = graphOf(
      {
        f: reg.create("flipbook-frame", { columns: 8, rows: 2, frame: 17.6 }),
        l: reg.create("length"),
        c: white(),
      },
      [edge("f", "uv", "l", "v")],
      [bind("albedo", "c", "out"), bind("alphaThreshold", "l", "out")],
    );
    const stage = compiler.compile(graph, FX_PARTICLE_TARGET).fragment;
    const code = [...stage.helperFunctions, ...stage.body].join("\n");
    expect(code).toContain("fxFlipbookFrameUV(");
    expect(code).not.toContain("fxAnimatedFrame");
    expect(code).not.toContain("mod(");
  });

  it("compiles a wired intensity into the artifact's outputs, beside albedo", () => {
    const graph = graphOf(
      {
        c: reg.create("constant", { type: "color", value: [1, 0.5, 0.2, 1] }),
        i: reg.create("constant", { type: "float", value: 2.5 }),
      },
      [],
      [bind("albedo", "c", "out"), bind("intensity", "i", "out")],
    );
    const compiled = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(compiled.outputs["intensity"]).toBeDefined();
    expect(compiled.outputs["albedo"]).toBeDefined();
  });

  it("describes animated-texture's grid as editable input pins and its uv as a target default", () => {
    const meta = FX_RENDER_CONTENT_NODES.find((d) => d.type === "animated-texture")?.describe();
    // `columns` is an editable input pin (the value on the pin), not a body param.
    expect(meta?.params["columns"]).toBeUndefined();
    expect(meta?.inputs.find((s) => s.key === "columns")?.control).toEqual({
      default: 1,
      min: 1,
      max: 64,
      step: 1,
    });
    expect(meta?.inputs.find((s) => s.key === "uv")?.default).toEqual({ targetInput: "p_uv" });
    expect(meta?.outputs.map((s) => s.key)).toEqual(["uvFrame", "uvNext", "factor"]);
  });
});

describe("standard render nodes - uv and mask content", () => {
  it("tile-uv scales the particle uv by its tiles and then shifts it by its offset", () => {
    const tile = reg.create("tile-uv", { tiles: [3, 4], offset: [0.5, 0.25] });
    expect(tile.targetReads).toContain("p_uv");
    const graph = graphOf(
      { t: tile, l: reg.create("length"), c: white() },
      [edge("t", "uv", "l", "v")],
      [bind("albedo", "c", "out"), bind("alphaThreshold", "l", "out")],
    );
    const body = compiler.compile(graph, FX_PARTICLE_TARGET).fragment.body.join("\n");
    expect(body).toMatch(/p_uv \* vec2\(3\.0, 4\.0\)\)? \+ vec2\(0\.5, 0\.25\)/);
  });

  it("polar-uv maps the particle uv to angle (0..1) and doubled radius about its center", () => {
    const polar = reg.create("polar-uv", { center: [0.25, 0.75] });
    expect(polar.targetReads).toContain("p_uv");
    const graph = graphOf(
      { p: polar, l: reg.create("length"), c: white() },
      [edge("p", "uv", "l", "v")],
      [bind("albedo", "c", "out"), bind("alphaThreshold", "l", "out")],
    );
    const body = programText(compiler.compile(graph, FX_PARTICLE_TARGET));
    const offset = /vec2 (\w+) = \(p_uv - vec2\(0\.25, 0\.75\)\);/.exec(body)?.[1];
    expect(offset).toBeDefined();
    expect(body).toContain(
      `vec2(((atan((${offset}).y, (${offset}).x) / 6.2831853) + 0.5), (length(${offset}) * 2.0))`,
    );
  });

  it("select prints as a GLSL ternary over the comparison, not-equal as equal with the values swapped", () => {
    const glslOf = (op: string): string => {
      const graph = graphOf(
        { s: reg.create("select", { op, ifTrue: 0.75, ifFalse: 0.25 }), c: white() },
        [],
        [bind("albedo", "c", "out"), bind("alphaThreshold", "s", "out")],
      );
      return programText(compiler.compile(graph, FX_PARTICLE_TARGET));
    };
    expect(glslOf("greater")).toContain("(0.0 > 0.5 ? 0.75 : 0.25)");
    expect(glslOf("not-equal")).toContain("(0.0 == 0.5 ? 0.25 : 0.75)");
  });

  it("distance and reflect print as GLSL length/dot over the uv", () => {
    const graph = graphOf(
      {
        uv: reg.create("uv"),
        r: reg.create("reflect"),
        d: reg.create("distance", { b: [0.5, 0.5] }),
        c: white(),
      },
      [
        edge("uv", "uv", "r", "incident"),
        edge("uv", "uv", "r", "normal"),
        edge("r", "out", "d", "a"),
      ],
      [bind("albedo", "c", "out"), bind("alphaThreshold", "d", "out")],
    );
    const body = programText(compiler.compile(graph, FX_PARTICLE_TARGET));
    const uv = new RegExp(`vec2 (${GLSL_NAME}) = p_uv;`).exec(body)?.[1] ?? "";
    expect(body).toContain(`(${uv} - (${uv} * (dot(${uv}, ${uv}) * 2.0)))`);
    expect(body).toMatch(new RegExp(String.raw`length\(\(${GLSL_NAME} - vec2\(0\.5, 0\.5\)\)\)`));
  });

  it("flow-uv drifts two half-cycle-apart phases along the flow, crossfaded so no snap is seen", () => {
    const flow = reg.create("flow-uv", { flow: [0.5, -1], speed: 2, strength: 0.3 });
    // Unwired, it flows the particle uv on the scene clock.
    expect(flow.targetReads).toEqual(expect.arrayContaining(["p_uv", "u_time"]));
    const graph = graphOf(
      {
        f: flow,
        a: reg.create("length"),
        b: reg.create("length"),
        ab: reg.create("binary-op", { op: "add" }),
        w: reg.create("binary-op", { op: "add" }),
        c: white(),
      },
      [
        edge("f", "uvA", "a", "v"),
        edge("f", "uvB", "b", "v"),
        edge("a", "out", "ab", "a"),
        edge("b", "out", "ab", "b"),
        edge("ab", "out", "w", "a"),
        edge("f", "blend", "w", "b"),
      ],
      [bind("albedo", "c", "out"), bind("alphaThreshold", "w", "out")],
    );
    // The phase, both drifts and uvB's weight read only the clock: the draw stage computes them
    // once per tick (the phase, `fract(t * 2)`, off `inputs.time`), the shader only offsets the uv.
    const shader = compiler.compile(graph, FX_PARTICLE_TARGET);
    const compute = shader.draw?.statements.join("\n") ?? "";
    expect(compute).toContain("fxFract((inputs.time * 2))");
    // uvB's weight: 1 as uvA snaps back (phase 0), 0 as uvB does (phase 0.5) - on the CPU too.
    expect(compute).toMatch(/Math\.abs\(\(1 - \(2 \* \w+\)\)\)/);
    const body = programText(shader);
    expect(body).not.toContain("u_time");
    // uvA drifts with the phase, uvB with the phase half a cycle on.
    const phase = new RegExp(
      String.raw`\(p_uv - \(vec2\(0\.5, -1\.0\) \* \((${GLSL_NAME}) \* 0\.3\)\)\)`,
    ).exec(body)?.[1];
    expect(drawUniformNames(shader)).toContain(phase);
    expect(body).toContain(`(p_uv - (vec2(0.5, -1.0) * (fract((${phase} + 0.5)) * 0.3)))`);
  });

  it("flow-uv runs on a wired time instead of the scene clock, on a VFX mesh too", () => {
    const graph = graphOf(
      {
        t: reg.create("constant", { type: "float", value: 3 }),
        f: reg.create("flow-uv"),
        c: white(),
      },
      [edge("t", "out", "f", "time")],
      [bind("albedo", "c", "out"), bind("alphaThreshold", "f", "blend")],
    );
    const body = compiler.compile(graph, FX_MESH_TARGET).fragment.body.join("\n");
    expect(body).toMatch(new RegExp(String.raw`fract\(\(${GLSL_NAME} \* 1\.0\)\)`));
    expect(body).not.toContain("u_time");
  });

  it("fresnel raises the rim (1 - facing) of the view direction to its power", () => {
    const fresnel = reg.create("fresnel", { power: 5 });
    // The view direction is world-space, from the fragment to the camera.
    expect(fresnel.targetReads).toEqual(
      expect.arrayContaining(["cameraPosition", "worldPosition"]),
    );
    const graph = graphOf(
      { n: reg.create("surface-normal"), f: fresnel, c: white() },
      [edge("n", "normal", "f", "normal")],
      [bind("albedo", "c", "out"), bind("alphaThreshold", "f", "out")],
    );
    const body = compiler.compile(graph, FX_PARTICLE_TARGET).fragment.body.join("\n");
    expect(body).toContain("cameraPosition - worldPosition");
    expect(body).toMatch(/pow\(\(1\.0 - .*\), 5\.0\)/);
  });
});

describe("standard render nodes - surface sources, literal-typed generics, pivot", () => {
  it("front-facing reads gl_FrontFacing, on a particle and on a VFX mesh", () => {
    expect(fragmentOf(reg.create("front-facing"), "out")).toContain("gl_FrontFacing");
    expect(fragmentOf(reg.create("front-facing"), "out", FX_MESH_TARGET)).toContain(
      "gl_FrontFacing",
    );
  });

  it("surface-position reads the fragment's world position, on a VFX mesh too", () => {
    for (const target of [FX_PARTICLE_TARGET, FX_MESH_TARGET]) {
      const graph = graphOf(
        { p: reg.create("surface-position"), l: reg.create("length"), c: white() },
        [edge("p", "position", "l", "v")],
        [bind("albedo", "c", "out"), bind("alphaThreshold", "l", "out")],
      );
      const stage = compiler.compile(graph, target).fragment;
      expect(stage.body.join("\n")).toContain("worldPosition");
    }
  });

  it("a mix of two typed-in colors resolves to vec4 with nothing wired", () => {
    const graph = graphOf(
      { m: reg.create("mix", { a: [1, 0, 0, 1], b: [0, 0, 1, 1], t: 0.25 }) },
      [],
      [bind("albedo", "m", "out")],
    );
    const compiled = compiler.compile(graph, FX_PARTICLE_TARGET);
    expect(compiled.outputs["albedo"]).toBeDefined();
    expect(compiled.fragment.body.join("\n")).toContain("vec4(");
  });

  it("a binary-op of two typed-in numbers resolves to float with nothing wired", () => {
    expect(fragmentOf(reg.create("binary-op", { op: "multiply", a: 0.5, b: 0.4 }), "out")).toMatch(
      /0\.5 \* 0\.4/,
    );
  });

  it("compose-transform shifts its translation by the rotated, scaled pivot", () => {
    const graph = graphOf(
      { t: reg.create("compose-transform", { scale: [2, 3, 1], pivot: [0, -0.5, 0] }), c: white() },
      [],
      [bind("albedo", "c", "out"), bind("particleTransform", "t", "out")],
    );
    const vertex = compiler.compile(graph, FX_PARTICLE_TARGET).vertex.body.join("\n");
    expect(vertex).toContain("-0.5");
  });
});

describe("literalGenericType", () => {
  it("takes the widest vector, else float for numbers, else nothing", () => {
    expect(literalGenericType([0.5, [1, 0, 0, 1]])).toBe("vec4");
    expect(
      literalGenericType([
        [1, 2],
        [1, 2, 3],
      ]),
    ).toBe("vec3");
    expect(literalGenericType([0, 1])).toBe("float");
    expect(literalGenericType([undefined])).toBeUndefined();
    expect(literalGenericType([])).toBeUndefined();
  });
});
