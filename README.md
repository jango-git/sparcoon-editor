# <img src="assets/logo.svg" width="30" height="30" alt="" align="top" /> Sparcoon Editor

A browser-based node editor for authoring particle effects for the
[sparcoon](https://github.com/jango-git/sparcoon/tree/experimental) runtime.

An effect is built from node graphs, driven by a timeline, and previewed live in a three.js
viewport. Compilation happens at author time: the editor turns the graphs into GLSL shaders and
JavaScript kernels as you edit, and exports the finished project as a single TypeScript module
carrying precompiled artifacts. The consuming application gets no graph, no compiler and no `eval` -
only the runtime.

Live build: <https://jango-git.github.io/sparcoon-editor/>

![Editor demo](assets/demo.gif)

## How an effect is put together

A project holds one **VFX group** - the root transform of the whole effect - and any number of
objects under it:

- **Emitter** - a particle system, owning two graphs: a **behavior graph** (per-particle
  simulation) and a **render graph** (per-particle material). It spawns nothing until a timeline
  event fires.
- **VFX mesh** - a single non-instanced mesh with a render graph but no simulation: the
  non-particle parts of an effect, such as a shockwave quad or a shaded prop.

Each graph ends in permanent **sink** nodes. The behavior graph feeds `Spawn` and `Update` - initial
and per-frame position, lifetime, velocity, and any per-particle attributes it declares. The render
graph feeds `Surface` - color, transforms, geometry, render mode, sorting and shadow flags.

The **timeline** owns everything time-based: **burst** events (a number of particles at one frame)
and **play** events (a rate for a duration, or infinite), keyframes on **Timeline Value** nodes -
the named, runtime-tunable graph inputs - and keyframes on any object's position, rotation and
scale.

## Rendering

Graphs compile to two GLSL tiers: **Standard** (WebGL2) and **Baseline** (WebGL1-compatible). The
preview can be switched between them, and an export always carries both - the runtime picks by capability.

Emitters can additionally simulate on the GPU through transform feedback. This is opt-in per
emitter and on by default; a graph that cannot compile to a GPU kernel runs on the JavaScript
kernel, which is always compiled. That is a fallback, not an error.

## Export

**Project JSON** is the editable format - the whole authored document with its assets.

**TypeScript export** produces a self-contained effect module: the precompiled artifacts plus a thin
subclass of the runtime's effect class. It imports only the runtime and a few three.js types, and
behaves like any other three.js object - construct it with the textures and meshes it references,
add it to your scene, and update it every frame.

Transform channels and Timeline Values can be marked as excluded from the export, which leaves them
for the host application to drive at runtime - useful for anything that has to follow gameplay
rather than a baked curve. The preview's own lighting rig is never exported: a lit graph reads the
host scene's lights, so it needs a light probe and a directional light there.

## Running locally

Requires Node 20+ and a browser with WebGL2 (WebGL1 is enough for the Baseline tier).

```sh
npm install
npm run dev     # rollup watch + dev server
npm run build   # bundle to dist/
```

`npm test` runs the Vitest suite; `npm run typecheck` and `npm run lint` cover the rest.

## License

MIT. See [LICENSE](LICENSE).
