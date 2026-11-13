import { describe, expect, it } from "vitest";

import { emitEffectModule } from "../../src/engine/emit/emitEffectModule";
import { evaluateEffectModule } from "../helpers/effectModule";
import {
  expectPlumeBehaviorLayoutMatchesKernel,
  expectPlumeLaunchesAndSimulates,
  expectPlumeRenderMatchesDirectCompile,
  expectPlumeSimulatesLikeDirectCompile,
  plumeGraphs,
} from "../helpers/plumeGraphs";

describe("emitEffectModule - round-trip", () => {
  it("emits a module importing its artifact types from sparcoon and exporting both render tiers + an authored behavior", () => {
    const { render, behavior } = plumeGraphs();
    const text = emitEffectModule(render, behavior);
    // The import is type-only (erased on transpile), so the specifier is only visible in the text.
    expect(text).toMatch(/^import \{[^}]*\bFXRenderArtifact\b[^}]*\} from "sparcoon";$/m);

    const module = evaluateEffectModule(text);
    for (const artifact of [module.renderBaseline, module.renderStandard]) {
      expect(artifact.lightingIntrinsics).toEqual([]);
      expect(artifact.color.outputs).toHaveProperty("albedo");
    }
    expect(module.behavior.spawn).toBeTypeOf("function");
    expect(module.behavior.update).toBeTypeOf("function");
  });

  it("imports the artifact types from a custom specifier when asked", () => {
    const { render, behavior } = plumeGraphs();
    expect(emitEffectModule(render, behavior, { importSpecifier: "@acme/fx" })).toMatch(
      /^import .* from "@acme\/fx";$/m,
    );
  });

  it("threads renderMode into the emitted render artifact options", () => {
    const { render, behavior } = plumeGraphs();

    // Must agree with the compileToArtifacts preview path, on both tiers (renderMode is
    // tier-independent).
    const off = evaluateEffectModule(emitEffectModule(render, behavior));
    const on = evaluateEffectModule(
      emitEffectModule(render, behavior, { renderMode: "alphaHash" }),
    );

    expect(off.renderBaseline.options).toEqual({ renderMode: "blending" });
    expect(off.renderStandard.options).toEqual({ renderMode: "blending" });
    expect(on.renderBaseline.options).toEqual({ renderMode: "alphaHash" });
    expect(on.renderStandard.options).toEqual({ renderMode: "alphaHash" });
  });

  it("the emitted baseline render artifact matches a direct compile", () => {
    const { render, behavior } = plumeGraphs();
    const emitted = evaluateEffectModule(emitEffectModule(render, behavior)).renderBaseline;
    expectPlumeRenderMatchesDirectCompile(emitted, render);
  });

  it("the emitted behavior artifact carries the same buffer layout + written set", () => {
    const { render, behavior } = plumeGraphs();
    const emitted = evaluateEffectModule(emitEffectModule(render, behavior)).behavior;
    expectPlumeBehaviorLayoutMatchesKernel(emitted, behavior);
  });

  it("the emitted spawn/update simulate identically to a direct compile (equivalence)", () => {
    const { render, behavior } = plumeGraphs();
    const emitted = evaluateEffectModule(emitEffectModule(render, behavior)).behavior;
    expectPlumeSimulatesLikeDirectCompile(emitted, behavior);
  });
});

describe("emitEffectModule - full golden (graph -> module -> fromArtifacts executes)", () => {
  it("an emitted module launches through FXEmitter.fromArtifacts and simulates", () => {
    const { render, behavior } = plumeGraphs();
    const module = evaluateEffectModule(emitEffectModule(render, behavior));
    expectPlumeLaunchesAndSimulates(module.renderBaseline, module.behavior);
  });
});
