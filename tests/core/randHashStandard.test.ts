import { describe, expect, it } from "vitest";

// JS transliteration of the standard-tier rand() hash (FXFunctions.Internal.ts's
// FX_RAND_GLSL_STANDARD_HELPER/fxRandHash1) - proves the hash's numeric properties
// (determinism, decorrelation) since no GLSL compiler runs in this headless container;
// GLSL-text correctness is covered separately by the generated-GLSL smoke tests.
// The counter is passed as an explicit parameter, standing in for fxRandCounter's
// per-invocation value (GLSL has no shared mutable global across invocations to model here).
function fxRandHash1(n: number): number {
  const shifted = (n << 13) | 0;
  const mixed = (shifted ^ n) | 0;
  const squared = Math.imul(mixed, mixed);
  const step1 = (Math.imul(squared, 15731) + Math.imul(mixed, 789221)) | 0;
  const step2 = (Math.imul(step1, step1) + 1376312589) | 0;
  return (step2 & 0x00ffffff) / 16777216.0;
}

function fxNextRandom(particleIndex: number, seed: number, counter: number): number {
  const combined = (particleIndex + Math.imul(seed, 57) + Math.imul(counter, 113)) | 0;
  return fxRandHash1(combined);
}

describe("standard-tier rand() hash (JS transliteration of FX_RAND_GLSL_STANDARD_HELPER)", () => {
  it("is deterministic - identical inputs always produce the identical draw", () => {
    expect(fxNextRandom(5, 100, 1)).toBe(fxNextRandom(5, 100, 1));
    expect(fxNextRandom(0, 0, 0)).toBe(fxNextRandom(0, 0, 0));
  });

  it("stays within [0, 1) across a wide sweep of inputs", () => {
    for (let particleIndex = 0; particleIndex < 200; particleIndex += 7) {
      const value = fxNextRandom(particleIndex, 42, 1);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("decorrelates across particle index - no two of 256 consecutive particles collide", () => {
    const seen = new Set<number>();
    for (let particleIndex = 0; particleIndex < 256; particleIndex += 1) {
      seen.add(fxNextRandom(particleIndex, 7, 1));
    }
    expect(seen.size).toBe(256);
  });

  it("decorrelates across the seed - a slot reborn under a new seed does not replay its prior draw", () => {
    // The whole reason u_fxRandSeed exists (core/ir/FXFunctions.Internal.ts's rand doc comment):
    // the same particleIndex/counter pair, reused across many unrelated rebirths under the
    // cursor/overwrite scheme, must not draw the same "random" value every time.
    const particleIndex = 12;
    const counter = 1;
    const draws = new Set<number>();
    for (let seed = 0; seed < 100; seed += 1) {
      draws.add(fxNextRandom(particleIndex, seed, counter));
    }
    expect(draws.size).toBeGreaterThan(90); // allow a handful of incidental collisions, not a pattern
  });

  it("decorrelates across the call-site counter - several rand() calls in one node never agree", () => {
    // spawn-box's surface mode calls rand() five times per particle (nodes-std/behavior/spawn.ts) -
    // this is the property that keeps its five draws independent within one invocation.
    const particleIndex = 3;
    const seed = 9;
    const draws = [1, 2, 3, 4, 5].map((counter) => fxNextRandom(particleIndex, seed, counter));
    expect(new Set(draws).size).toBe(5);
  });

  it("roughly covers [0, 1) rather than clustering in a narrow band (coarse distribution check)", () => {
    const buckets = new Array<number>(10).fill(0);
    const sampleCount = 2000;
    for (let particleIndex = 0; particleIndex < sampleCount; particleIndex += 1) {
      const value = fxNextRandom(particleIndex, 123, 1);
      buckets[Math.min(9, Math.floor(value * 10))] += 1;
    }
    // Not a rigorous uniformity test - just confirms no bucket is empty or wildly dominant for a
    // hash this simple over a couple thousand samples.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(sampleCount / 10 / 4);
      expect(count).toBeLessThan((sampleCount / 10) * 4);
    }
  });
});
