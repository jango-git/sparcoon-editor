import { describe, expect, it } from "vitest";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import type { FXCurveData } from "../../src/engine/core/nodes/FXParamSpec";
import { DEFAULT_CURVE } from "../../src/engine/core/nodes/FXParamSpec";
import { FXCompilerBaseline } from "../../src/engine/render/compiler/FXCompilerBaseline";
import type { FXRenderNode } from "../../src/engine/render/FXRenderNode";
import { FX_PARTICLE_TARGET } from "../../src/engine/render/target/FXParticleRenderTarget";
import { bind, edge, graphOf, runKernel } from "../helpers/graphBuild";
import { behaviorRegistry, renderRegistry } from "../helpers/stdRegistry";

// The Curve node (`ramp`) remaps a scalar `t` through an editable smooth/sharp curve, baked
// inline (a piecewise-linear mix chain over pre-sampled points) so it runs in both backends.

const behavior = behaviorRegistry();
const render = renderRegistry();

/** constant(t) -> ramp; binds `out` into the float `positionX` slot, runs, reads it back. */
function rampAt(curve: FXCurveData | undefined, t: number): number {
  return rampNodeAt(behavior.create("ramp", curve === undefined ? undefined : { curve }), t);
}

function rampNodeAt(ramp: FXBehaviorNode, t: number): number {
  const graph = graphOf(
    { t: behavior.create("constant", { value: t, type: "float" }), ramp },
    [edge("t", "out", "ramp", "t")],
    [bind("positionX", "ramp", "out")],
  );
  return runKernel(graph).position[0];
}

/** constant(rgb) + ramp(alpha) -> combine-color -> albedo, on the render baseline compiler. */
function renderRampGraph(curve: FXCurveData | undefined): FXGraph<FXRenderNode> {
  return graphOf(
    {
      rgb: render.create("constant", { value: [1, 0, 0], type: "vec3" }),
      ramp: render.create("ramp", curve === undefined ? undefined : { curve }),
      combine: render.create("combine-color"),
    },
    [edge("rgb", "out", "combine", "rgb"), edge("ramp", "out", "combine", "alpha")],
    [bind("albedo", "combine", "color")],
  );
}

const sharp = (position: number, value: number): FXCurveData["points"][number] => ({
  position,
  value,
  interpolation: "sharp",
});
const smooth = (position: number, value: number): FXCurveData["points"][number] => ({
  position,
  value,
  interpolation: "smooth",
});

describe("curve node (ramp)", () => {
  it("passes the default identity curve straight through (out ~= t)", () => {
    // DEFAULT_CURVE: (0,0) -> (1,1). A straight line stays exact under discretization
    // (linear samples re-lerp exactly), whichever endpoints' smoothing.
    expect(rampAt(DEFAULT_CURVE, 0)).toBeCloseTo(0, 6);
    expect(rampAt(DEFAULT_CURVE, 0.25)).toBeCloseTo(0.25, 6);
    expect(rampAt(DEFAULT_CURVE, 0.5)).toBeCloseTo(0.5, 6);
    expect(rampAt(DEFAULT_CURVE, 1)).toBeCloseTo(1, 6);
    expect(rampAt(undefined, 0.5)).toBeCloseTo(0.5, 6); // no param -> same default
  });

  it("is a linear triangle when all anchors are sharp", () => {
    const tri: FXCurveData = { points: [sharp(0, 0), sharp(0.5, 1), sharp(1, 0)] };
    // The rising/falling edges are linear regions, so sampling is exact there.
    expect(rampAt(tri, 0.25)).toBeCloseTo(0.5, 6);
    expect(rampAt(tri, 0.75)).toBeCloseTo(0.5, 6);
  });

  it("a smooth arch bulges above the linear (sharp) reading of the same anchors", () => {
    const anchors: [number, number][] = [
      [0, 0],
      [0.5, 1],
      [1, 0],
    ];
    const smoothArch: FXCurveData = { points: anchors.map(([p, v]) => smooth(p, v)) };
    const sharpArch: FXCurveData = { points: anchors.map(([p, v]) => sharp(p, v)) };
    // At t=0.25 the sharp arch reads the linear 0.5; Catmull-Rom smoothing lifts it well above.
    expect(rampAt(sharpArch, 0.25)).toBeCloseTo(0.5, 6);
    expect(rampAt(smoothArch, 0.25)).toBeGreaterThan(0.55);
  });

  it("extrapolates flat outside [first, last] anchor", () => {
    const curve: FXCurveData = { points: [smooth(0.25, 0.2), smooth(0.75, 0.8)] };
    expect(rampAt(curve, 0)).toBeCloseTo(0.2, 6); // below first anchor -> first value
    expect(rampAt(curve, 1)).toBeCloseTo(0.8, 6); // above last anchor -> last value
  });

  it("a curve re-tuned through applyParams bakes into the next compile", () => {
    const ramp = behavior.create("ramp");
    ramp.applyParams?.({ curve: { points: [sharp(0, 1), sharp(1, 0)] } });
    expect(rampNodeAt(ramp, 0.25)).toBeCloseTo(0.75, 6);
  });

  it("rejects a malformed curve instead of baking NaN, and accepts a well-formed one", () => {
    const malformed = [
      { position: "x", value: 1 },
      { position: 0, value: Number.NaN },
      { position: 0, value: 0, interpolation: "wobbly" },
    ];
    for (const point of malformed) {
      expect(() => behavior.create("ramp", { curve: { points: [point] } })).toThrow(
        /FXNodeDefinition/,
      );
    }
    expect(() =>
      behavior.create("ramp", { curve: { points: [sharp(0, 0), smooth(1, 2)] } }),
    ).not.toThrow();
  });

  // The bake places knots adaptively: one `mix` per emitted segment, and combine-color adds none,
  // so counting `mix(` in the fragment is exactly the curve's segment count.
  function rampSegments(curve: FXCurveData | undefined): number {
    const src = new FXCompilerBaseline()
      .compile(renderRampGraph(curve), FX_PARTICLE_TARGET)
      .fragment.body.join("\n");
    return (src.match(/mix\(/g) ?? []).length;
  }

  it("collapses a straight line to a single segment (adaptive, not a fixed grid)", () => {
    // The default identity curve is linear, so its reconstruction needs no interior knots.
    expect(rampSegments(DEFAULT_CURVE)).toBe(1);
    // An all-sharp triangle is two exact linear pieces - a knot at each anchor, nothing between.
    const tri: FXCurveData = { points: [sharp(0, 0), sharp(0.5, 1), sharp(1, 0)] };
    expect(rampSegments(tri)).toBe(2);
  });

  it("spends more segments on a curved region but never exceeds the 32-point budget", () => {
    const arch: FXCurveData = { points: [smooth(0, 0), smooth(0.5, 1), smooth(1, 0)] };
    // A full-amplitude smooth bump genuinely needs several linear pieces per side.
    expect(rampSegments(arch)).toBeGreaterThan(2);
    // A pathologically wiggly curve is capped: at most CURVE_MAX_POINTS (32) knots => 31 segments.
    const wiggle: FXCurveData = {
      points: Array.from({ length: 12 }, (_, i) => smooth(i / 11, i % 2)),
    };
    expect(rampSegments(wiggle)).toBeLessThanOrEqual(31);
  });
});
