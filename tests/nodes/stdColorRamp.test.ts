import { describe, expect, it } from "vitest";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXGradientData } from "../../src/engine/core/nodes/FXParamSpec";
import { DEFAULT_GRADIENT } from "../../src/engine/core/nodes/FXParamSpec";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry } from "../helpers/stdRegistry";

// Color Ramp maps a scalar `t` through a gradient and emits a single RGBA `vec4` color.
// To read rgb + alpha separately in the behavior backend these route the ramp through a
// Split Color node and bind each part into a core state slot: `rgb` -> the `position` vec3
// (rgb in position[0..2]); `alpha` -> `positionX` (a float).

const reg = behaviorRegistry();

/** constant(t) -> color-ramp -> split-color; binds one split output to `slot`, runs, reads it. */
function evalRamp(
  gradient: FXGradientData | undefined,
  t: number,
  output: "rgb" | "alpha",
  slot: string,
): Record<string, Float32Array> {
  const ramp = reg.create("color-ramp", gradient === undefined ? undefined : { gradient });
  return runKernel(rampGraph(ramp, t, output, slot));
}

function rampGraph(
  ramp: FXBehaviorNode,
  t: number,
  output: "rgb" | "alpha",
  slot: string,
): FXGraph<FXBehaviorNode> {
  return graphOf(
    {
      t: reg.create("constant", { value: t, type: "float" }),
      ramp,
      split: reg.create("split-color"),
    },
    [edge("t", "out", "ramp", "t"), edge("ramp", "color", "split", "color")],
    [bind(slot, "split", output)],
  );
}

/** rgb the ramp emits at `t` for `gradient`. */
function colorAt(gradient: FXGradientData | undefined, t: number): [number, number, number] {
  const b = evalRamp(gradient, t, "rgb", "position");
  return [b.position[0], b.position[1], b.position[2]];
}

/** the alpha the ramp emits at `t` for `gradient`. */
function alphaAt(gradient: FXGradientData | undefined, t: number): number {
  return evalRamp(gradient, t, "alpha", "positionX").position[0];
}

describe("color-ramp node", () => {
  it("samples the default black->white ramp linearly across t", () => {
    // DEFAULT_GRADIENT: (0,0,0,1) @0 -> (1,1,1,1) @1.
    expect(colorAt(DEFAULT_GRADIENT, 0)).toEqual([0, 0, 0]);
    const mid = colorAt(DEFAULT_GRADIENT, 0.5);
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[1]).toBeCloseTo(0.5, 6);
    expect(mid[2]).toBeCloseTo(0.5, 6);
    expect(colorAt(DEFAULT_GRADIENT, 1).map((c) => Math.round(c))).toEqual([1, 1, 1]);
    expect(alphaAt(DEFAULT_GRADIENT, 0.5)).toBeCloseTo(1, 6);
  });

  it("interpolates color and alpha independently between stops", () => {
    // red-transparent (1,0,0,0) @0 -> blue-opaque (0,0,1,1) @1.
    const g: FXGradientData = {
      stops: [
        { position: 0, color: [1, 0, 0, 0] },
        { position: 1, color: [0, 0, 1, 1] },
      ],
    };
    const mid = colorAt(g, 0.5);
    expect(mid[0]).toBeCloseTo(0.5, 6); // r
    expect(mid[1]).toBeCloseTo(0, 6); // g
    expect(mid[2]).toBeCloseTo(0.5, 6); // b
    expect(alphaAt(g, 0.5)).toBeCloseTo(0.5, 6);
    expect(alphaAt(g, 0.25)).toBeCloseTo(0.25, 6);
  });

  it("clamps outside [first, last] to a flat color (t below 0 / above 1)", () => {
    const g: FXGradientData = {
      stops: [
        { position: 0.25, color: [0.2, 0.2, 0.2, 1] },
        { position: 0.75, color: [0.8, 0.8, 0.8, 1] },
      ],
    };
    expect(colorAt(g, 0)[0]).toBeCloseTo(0.2, 6); // below first stop -> first color
    expect(colorAt(g, 1)[0]).toBeCloseTo(0.8, 6); // above last stop -> last color
  });

  it("honors a three-stop gradient at its middle stop", () => {
    const g: FXGradientData = {
      stops: [
        { position: 0, color: [0, 0, 0, 1] },
        { position: 0.5, color: [1, 0, 0, 1] },
        { position: 1, color: [0, 0, 0, 1] },
      ],
    };
    const mid = colorAt(g, 0.5);
    expect(mid[0]).toBeCloseTo(1, 6);
    expect(mid[1]).toBeCloseTo(0, 6);
  });

  it("a gradient re-tuned through applyParams bakes into the next compile", () => {
    const ramp = reg.create("color-ramp");
    ramp.applyParams?.({
      gradient: {
        stops: [
          { position: 0, color: [1, 1, 1, 0] },
          { position: 1, color: [0, 0, 0, 1] },
        ],
      },
    });
    expect(runKernel(rampGraph(ramp, 0.25, "alpha", "positionX")).position[0]).toBeCloseTo(0.25, 6);
  });

  it("rejects a malformed gradient (non-finite / wrong-width color)", () => {
    expect(() => reg.create("color-ramp", { gradient: { stops: [] } })).toThrow();
    expect(() =>
      reg.create("color-ramp", {
        gradient: { stops: [{ position: 0, color: [1, 0, 0] } as never] },
      }),
    ).toThrow();
  });

  it("combine-color and split-color round-trip rgb + alpha (vec4)", () => {
    // constant(rgb) + constant(a) -> combine-color -> split-color -> bind rgb & alpha back.
    const build = (output: "rgb" | "alpha", slot: string): Record<string, Float32Array> =>
      runKernel(
        graphOf(
          {
            rgb: reg.create("constant", { value: [0.1, 0.2, 0.3], type: "vec3" }),
            a: reg.create("constant", { value: 0.4, type: "float" }),
            combine: reg.create("combine-color"),
            split: reg.create("split-color"),
          },
          [
            edge("rgb", "out", "combine", "rgb"),
            edge("a", "out", "combine", "alpha"),
            edge("combine", "color", "split", "color"),
          ],
          [bind(slot, "split", output)],
        ),
      );
    const rgb = build("rgb", "position").position;
    expect(rgb[0]).toBeCloseTo(0.1, 6);
    expect(rgb[1]).toBeCloseTo(0.2, 6);
    expect(rgb[2]).toBeCloseTo(0.3, 6);
    expect(build("alpha", "positionX").position[0]).toBeCloseTo(0.4, 6);
  });

  // hsl-adjust takes a color in and shifts its hue/saturation/lightness in HSL space.
  // Feed a constant(vec4) color, adjust, split, read the rgb back.
  const adjustRgb = (
    color: readonly number[],
    params: { hueShift?: number; saturation?: number; lightness?: number },
  ): [number, number, number] => {
    const graph = graphOf(
      {
        c: reg.create("constant", { value: [...color], type: "vec4" }),
        hue: reg.create("constant", { value: params.hueShift ?? 0, type: "float" }),
        sat: reg.create("constant", { value: params.saturation ?? 1, type: "float" }),
        lit: reg.create("constant", { value: params.lightness ?? 1, type: "float" }),
        hsl: reg.create("hsl-adjust"),
        split: reg.create("split-color"),
      },
      [
        edge("c", "out", "hsl", "color"),
        edge("hue", "out", "hsl", "hueShift"),
        edge("sat", "out", "hsl", "saturation"),
        edge("lit", "out", "hsl", "lightness"),
        edge("hsl", "color", "split", "color"),
      ],
      [bind("position", "split", "rgb")],
    );
    const [r, g, b] = runKernel(graph).position;
    return [r, g, b];
  };
  const nearRgb = (got: number[], want: number[]): void => {
    for (let i = 0; i < 3; i++) {
      expect(got[i]).toBeCloseTo(want[i], 5);
    }
  };

  it("hsl-adjust passes a color through unchanged at identity settings", () => {
    nearRgb(adjustRgb([0.2, 0.5, 0.7, 1], {}), [0.2, 0.5, 0.7]);
    nearRgb(
      adjustRgb([0.9, 0.1, 0.3, 1], { hueShift: 0, saturation: 1, lightness: 1 }),
      [0.9, 0.1, 0.3],
    );
  });

  it("hsl-adjust rotates hue (red -> green -> blue at +/-1/3 turns)", () => {
    nearRgb(adjustRgb([1, 0, 0, 1], { hueShift: 1 / 3 }), [0, 1, 0]);
    nearRgb(adjustRgb([1, 0, 0, 1], { hueShift: 2 / 3 }), [0, 0, 1]);
  });

  it("hsl-adjust with saturation 0 collapses to the greyscale lightness", () => {
    // red (1,0,0) has L = 0.5 -> desaturating to 0 yields mid grey.
    nearRgb(adjustRgb([1, 0, 0, 1], { saturation: 0 }), [0.5, 0.5, 0.5]);
  });

  it("hsl-adjust with lightness 0 yields black, and passes alpha through", () => {
    nearRgb(adjustRgb([0.3, 0.6, 0.9, 0.4], { lightness: 0 }), [0, 0, 0]);
    const graph = graphOf(
      {
        c: reg.create("constant", { value: [0.3, 0.6, 0.9, 0.4], type: "vec4" }),
        hsl: reg.create("hsl-adjust", { lightness: 0 }),
        split: reg.create("split-color"),
      },
      [edge("c", "out", "hsl", "color"), edge("hsl", "color", "split", "color")],
      [bind("positionX", "split", "alpha")],
    );
    expect(runKernel(graph).position[0]).toBeCloseTo(0.4, 6); // alpha untouched
  });
});
