# Exported effects: where the generated code can get faster

Notes from a read of the code the editor actually ships. Every bundled preset was exported through
`emitProjectModule` and the resulting TypeScript modules were read: the CPU `spawn`/`update`
kernels, the GPU transform-feedback kernels and the render shaders of both tiers. Reading the
output rather than the compiler shows what really runs, not what the compiler is meant to produce.

Every finding is static, from reading the code and counting patterns in it. Nothing was profiled
or benchmarked. Where a gain is given, it is an estimate from operation counts.

One item is done (see [Done](#done)). The rest are not implemented.

## What the presets export

| Preset          |     Raw |   gzip |
| --------------- | ------: | -----: |
| Destruction     |  383 KB |  41 KB |
| Lightning Crack |  231 KB |  27 KB |
| Campfire        |  161 KB |  17 KB |
| Fireworks       |  149 KB |  15 KB |
| Portal          |  115 KB |  14 KB |
| Shield          |  104 KB |  15 KB |
| Fireflies       |  101 KB |  10 KB |
| Sparks          |   31 KB |   7 KB |
| All nine        | 1.28 MB | 146 KB |

The raw size splits roughly as follows:

- **GLSL:** about 50%, across render shaders and GPU kernels.
- **JS kernel functions:** about 29%.
- **Everything else:** specs, literals and the effect class.

Destruction is large because its debris emitters compile to near-identical artifacts. gzip absorbs
that well, so deduplicating them is not worth much.

## Where the time goes

**The CPU tier is cheap in every preset.** The emitters that actually run on the CPU are:

- the death-reaction sources, which are forced onto the CPU;
- the emitters with no GPU kernel, such as Peony, Shell, Campfire's Embers and the small
  Destruction particles.

Their `update` is 12–21 plain arithmetic statements per particle, with no noise. The expensive
work is on the GPU tier and in the render shaders.

This settles the earlier WebAssembly question for now. A WASM simulation backend would speed up a
tier that is not the bottleneck in any shipped effect.

## Done

### GPU kernels skip dead slots

`FXTransformFeedbackSimulationHolder` draws the whole capacity every tick
(`drawArrays(gl.POINTS, 0, mesh.capacity)`). The fused kernel used to run its full update branch
(noise, collisions, curves) on every slot, alive or not. Burst emitters sit mostly empty, so most
of that work was spent on dead particles.

The kernel now has a pass-through branch between the birth branch and the update branch:

```glsl
} else if (in_lifecycle.x >= in_lifecycle.y) {
    out_<buffer> = in_<buffer>;   // every buffer, unchanged
} else {
    // update
}
```

How it behaves:

- **Same test as the rest of the runtime.** `age >= lifetime` is the test the render material culls
  by and the trail history skips by.
- **Age freezes,** so a dead slot stays dead until a birth overwrites it.
- **Never-spawned slots count as dead:** their lifecycle is zeroed, and `0 >= 0` holds.
- **A particle that dies this tick still gets its last update,** because the test reads the age
  before the step.
- **Little warp divergence:** live particles in the ring buffer are contiguous.

The change is in `src/engine/behavior/FXKernelBuildStandard.Internal.ts`, and
`tests/core/fusedProgramStandard.test.ts` covers the branch.

## Proposed

These are ordered by gain against effort.

### 1. Evaluate authored curve segments as cubics

**What happens now.** `curveBake.ts` samples a smooth (Catmull-Rom) curve at adaptively placed
knots, with an error of at most 1/256 of the output range and at most 32 knots. It then emits a
chain of nested `mix` calls, one per knot interval, at about 7 ALU per link.

Authors place few anchors. In the presets:

- 66 of 82 curves have 3 or 4 anchors, which is 2 or 3 segments.
- The bake still cuts them into 15–26 linear links.

The exported shaders hold 34 such curves, all in vertex shaders, averaging 16.6 links. That is
about 116 ALU per curve per vertex, a large share of each vertex shader.

**Proposal.** Evaluate each authored segment exactly, as the same cubic Hermite the bake already
samples. To stay branchless and avoid arrays, write the curve as a sum of per-segment increments:

```
v = v0 + Σ_k  s_k · (c1_k + s_k · (c2_k + s_k · c3_k)),   s_k = clamp((t − p_k) · inv_k, 0, 1)
```

How the formula works:

- **The sum telescopes.** A segment `t` has passed has `s = 1` and adds its full step
  `v_{k+1} − v_k`. A segment ahead has `s = 0` and adds nothing. What remains is the cubic of the
  current segment.
- **The editor precomputes `c1..c3`** at compile time, and they become literals.
- **A smooth segment costs about 10 ALU:** a clamp plus Horner's rule.
- **A sharp (linear) segment is `s · Δv`.**
- **Ends:** before the first anchor the value is `v0`, and after the last it is the last value.
  This matches `sampleCurveAnchors`.

**What it gives:**

- **Cost:** a 3–4 anchor curve drops from about 116 ALU to about 25–35, and the shader text shrinks
  with it.
- **Accuracy:** the result is exact. The current approximation error of up to 1/256 goes away.
- **Reach:** it needs only `lit`, `bin` and `clamp`, which the IR already has. So it works on all
  three backends: Standard, Baseline (GLSL ES 1.00 cannot dynamically index const arrays in a
  vertex shader) and JS.
- **Cost model:** `fxRamp`'s `cost` becomes per authored segment instead of per baked link.

**Caveat.** Catmull-Rom can overshoot its anchors. That is a property of the authored curve, which
the bake already reproduces, and exact evaluation keeps it exactly.

**Expected effect.**

- On desktop, vertices are rarely the bottleneck for quads, so FPS barely moves.
- It pays on weak mobile GPUs and on mesh particles (Rock, Chunk*, Pillar), which have many
  vertices per particle.
- The smaller shaders also compile faster, which shortens the hitch on an effect's first play under
  ANGLE/D3D.

**Gradients** (`color.ts`) average about 3 stops and are already linear by design, so they stay as
they are.

**Alternative considered.** Binary search over the baked knots in const arrays, at about 20–25 ALU.
It needs a new array IR expression, it only works on Standard, and it keeps the approximation. The
cubic form is better on every count.

### 2. Constant and copy propagation in the IR

**What happens now.** There is no folding pass. The JS kernel pipeline is: locals, then CSE
(`cse.Internal.ts`), then loop-invariant partitioning, then printing. GLSL is printed directly and
leaves CSE to the driver.

**What the output carries:**

| Pattern                                                                                                                               |        Count |
| ------------------------------------------------------------------------------------------------------------------------------------- | -----------: |
| JS locals that are bare aliases, literals or refs (`x = (y)`, `constant_out = (0)`, `world_matrix_out_m4 = (emitter.worldMatrix[4])`) | 1803 of 3714 |
| JS expressions made only of literals                                                                                                  |          288 |
| Identity operations (`+ 0`, `* 1`, `0 *`) in JS                                                                                       |          608 |
| Identity operations in GLSL                                                                                                           |          768 |
| Safe-division guards `((l == 0.0 ? 1.0 : 0.0) != 0.0 ? 1.0 : l)`, many on constants                                                   |          256 |
| `emitter.worldMatrix[k]` reads                                                                                                        |          912 |

The matrix reads pile up because each matrix node declares its own 16 aliases, and CSE does not
merge them: it treats refs as cheap.

Alias lines alone are about 30% of the JS kernel text, roughly 110 KB of the 1.28 MB raw.

**Proposal.** One IR pass over a phase's locals, run before CSE on the JS side and before hoisting
on the render side. It would:

- propagate literal and alias/ref locals into their uses;
- fold `bin`, `un` and `call` on literal arguments, for a whitelist of pure functions only (never
  hashes, `rand` or `raw`);
- drop the identities `x * 1`, `x + 0`, `x - 0` and `x / 1`;
- fold a `select` on a literal condition, and a swizzle of a literal or `construct`.

**Expected effect.** The runtime gain is small:

- TurboFan already folds constants and propagates copies, and GPU drivers fold GLSL literals.
- The real gains come from three things:
  - `x + 0` and `0 * x`, which engines may not fold under IEEE rules (−0, NaN);
  - functions that rarely tier up, such as `spawn`, which run every alias in the interpreter;
  - less text to parse and compile.
- The main gain is size and shader compile time.

**Caveats:**

- `0 * x → 0` changes NaN and Inf behavior. Leave it out, or enable it on purpose.
- Folding happens in double while the GPU computes in float32, so values can differ by about 1 ulp.
  CPU/GPU parity holds because both backends fold the same IR.
- Locals read by sinks and buffer writes must survive.
- Some tests match generated text and will need updating.

### 3. Analytic-gradient curl noise

Curl noise is the heaviest thing in the GPU kernels.

**What happens now.** It takes central differences: 12 `noise3` samples per octave, each 8 integer
hashes.

| Where                                                  | Octaves | `noise3` calls per particle per tick |
| ------------------------------------------------------ | ------: | -----------------------------------: |
| Fireflies                                              |       2 |                 24, about 190 hashes |
| Campfire (smoke), Portal, Lightning Crack, Destruction |       1 |                                   12 |

This is the same in the JS kernel and the GLSL kernel.

**Proposal.** Use value noise that returns its analytic gradient. That is 3 evaluations per octave
instead of 12, about 4 times less work. The field barely changes: the difference step is
ε = 0.01, and the fade derivative is continuous. The JS helper in `sparcoon/src/miscellaneous/fxMath.ts`
and the GLSL helper in the editor are a CPU/GPU contract, so they must change in lockstep.

## Not an issue

**Per-particle math in fragment shaders.** The hoist pass (`src/engine/core/codegen/hoist.Internal.ts`)
already moves per-particle fragment values into the vertex stage. In Destruction's chunks, curves
and color ramps over the life ratio stay in the fragment shader only on the Baseline tier. That is
the intended fallback when a lit mesh runs out of varyings. On Standard they are hoisted.

## How the exports were produced

The editor's installed `node_modules/sparcoon` was stale when this was written: it predates
`FX_LIGHTING_INTRINSIC`. As a result:

- the stock export tests failed on import;
- `tsc -b` reported 32 errors, all from mismatched runtime types.

The presets were exported with a throwaway vitest config that aliases `sparcoon` and
`sparcoon/editor` to the local `../sparcoon/dist`, then running a small test that calls
`emitProjectModule` on each JSON in `src/persistence/presets/`. Reinstalling the dependency from the
local sparcoon makes the stock setup work again.
