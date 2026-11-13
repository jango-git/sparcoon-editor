# <img src="assets/logo.svg" width="30" height="30" alt="" align="top" /> Sparcoon Editor

A node-based visual effects editor for three.js that runs in the browser. You build the effect from
nodes and get back one self-contained TypeScript module, played by the
[`sparcoon`](https://github.com/jango-git/sparcoon) runtime.

**[Open the editor](https://jango-git.github.io/sparcoon-editor/)** -
[Runtime](https://github.com/jango-git/sparcoon) -
[npm](https://www.npmjs.com/package/sparcoon)

<table>
  <tr>
    <td align="center"><img src="assets/gallery/campfire.webp" width="400" alt="Campfire" /><br /><b>Campfire</b></td>
    <td align="center"><img src="assets/gallery/lightning-crack.webp" width="400" alt="Lightning Crack" /><br /><b>Lightning Crack</b></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gallery/portal.webp" width="400" alt="Portal" /><br /><b>Portal</b></td>
    <td align="center"><img src="assets/gallery/shield.webp" width="400" alt="Energy Shield" /><br /><b>Energy Shield</b></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gallery/fireworks.webp" width="400" alt="Fireworks" /><br /><b>Fireworks</b></td>
    <td align="center"><img src="assets/gallery/destruction.webp" width="400" alt="Destruction" /><br /><b>Destruction</b></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gallery/fireflies.webp" width="400" alt="Fireflies" /><br /><b>Fireflies</b></td>
    <td align="center"><img src="assets/gallery/sparks.webp" width="400" alt="Sparks" /><br /><b>Sparks</b></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="assets/editor.webp" width="100%" alt="The Portal preset being built in the editor" /><br /><b>Portal, built node by node in the editor</b></td>
  </tr>
</table>

Every effect above is a bundled preset built from the editor's own nodes: press `Ctrl+Space`, pick
it on the **Content** screen and hit **Load**.

> **Pre-release.** The editor works end to end, but the project format and the exported artifact are
> not frozen yet - breaking changes are possible before the first stable release. A project lives in
> your browser, so export anything you care about to `.json`.

## Who this is for

VFX artists building three.js content under hard constraints - mobile ad creatives and playables
first, where the build has a size budget, the target device may be five years old, and review will
not pass anything that generates code at runtime.

Authoring works the way it does in a game engine: emitters, spawn shapes, forces, bursts, a timeline.
The editor compiles all of it into shaders and simulation code as you work. Only the compiled result
goes to production.

If you are coming from **Unity VFX Graph, Niagara, Effekseer or PopcornFX**, the authoring model will
feel familiar. The difference is the destination: the result lives in an ordinary three.js scene.

**This is probably not what you need if** you are looking for a full 3D scene editor (only effects
are authored here), you assemble effects from data at runtime (compilation happens at authoring time
by design), you expect to drop the result in without a build step (the output is an ES module that
expects a bundler), or you work on another engine - Babylon.js, PlayCanvas, PixiJS.

### Why it will work in an ad build

- **No runtime code generation.** The export is ready GLSL plus ordinary JavaScript functions; neither
  `eval` nor `new Function` is used anywhere.
- **No dependency tail.** The runtime has exactly one peer dependency: `three`.
- **Old hardware has a path.** Every graph also compiles to a WebGL1-compatible tier (see
  [Rendering and simulation](#rendering-and-simulation)).
- **Instancing.** Billboards and mesh particles draw in one call per emitter, plus one for its trail.
- **The assets stay yours.** Textures and meshes are passed into the effect's constructor, so how you
  load, inline or pack them into a single file is your decision.
- **Tree-shakeable ESM with full types**, unbundled and unminified, so your bundler treats it like any
  other source and can transpile it as far down as you need.

## Quick start (nothing to install)

1. Open the **[live build](https://jango-git.github.io/sparcoon-editor/)**.
2. Press `Ctrl+Space` to open the **Content** screen, pick the **Sparks** preset and hit **Load**.
3. Close the screen and press `Space` - the effect starts playing in the viewport.
4. Change something - a node value in the graph, a burst on the timeline - and watch the preview
   rebuild while you type.
5. Go back to **Content** and hit **Export TypeScript** to get the module described below.

Nothing is uploaded anywhere: the project lives in your browser (autosaved to `localStorage`), and
`Ctrl+S` writes it out as `.json`.

## Using an exported effect

The export is one module per project: a named `FXEffect` subclass - a `THREE.Group` - plus a typed
interface for the assets the project references. Install the runtime and add the effect to your
scene:

```sh
npm install sparcoon three
```

```ts
const effect = new MyEffect(assets, { renderer, camera }); // emitted by the editor
scene.add(effect);
effect.play();
// each frame: FXWorld.update(deltaSeconds) before rendering
```

Channels marked **Exclude from export** stay under your code's control - that is how anything which
has to follow gameplay rather than a baked curve gets wired, through calls typed against the names
the project declares. Playback, parameters, emission from code, worlds and disposal are covered in
the [runtime's README](https://github.com/jango-git/sparcoon#readme).

## What an effect is made of

A project holds one **VFX group** - the root transform of the whole effect - and any number of
objects under it:

- **Emitter** - a particle system. It owns two graphs: a **Behavior graph** (per-particle simulation)
  and a **Render graph** (per-particle material), plus an optional **Trail graph** - a ribbon drawn
  behind every particle along its recorded path, added with the graph switch's **Add trail**. It
  spawns nothing until a timeline event fires.
- **VFX mesh** - a single non-instanced mesh with a render graph and no simulation: the non-particle
  parts of an effect, such as a shockwave quad or a shaded prop.

Every graph ends in permanent **sink** nodes. The behavior graph feeds the **Spawn sink** and the
**Update sink** - initial and per-frame position, lifetime, velocity and any declared particle
attributes. The render graph feeds the **Surface sink** - color, transforms, geometry, render mode,
sorting and shadow flags. A cast shadow is drawn from the color's alpha alone, so lighting and
color work cost the shadow pass nothing; **Shadow Threshold** moves where the shadow ends without
touching the visible surface. A trail graph feeds the same sink, shaped for a ribbon: color, **Width**
(which can taper along the trail through its UV), and how many points of each particle's path it
keeps and how often it records one. Lighting and surface-normal nodes are not offered there, and a
trail cannot be combined with depth sorting. A material that needs more vertex attributes or
varyings than the GPU guarantees is flagged on its graph: an error past WebGL2's limits, a warning
past WebGL1's.

A Timeline Value name is one value across all of an emitter's graphs - one track, one
`setEmitterParam` - so every node declaring it must agree on its type and default.

The **timeline** owns everything time-based: **Burst** events (how many particles to release on one
frame) and **Play** events (a rate per second or per unit the emitter travels, over a duration or
infinite), keyframes on **Timeline Value** nodes - named graph inputs you can drive at runtime - and
keyframes on any object's position, rotation and scale.

## What is inside

**The node library** is split by graph. Behavior: spawn shapes (box, sphere, cone, cylinder, disc,
torus), forces (gravity, drag, point force, vortex, turbulence, firework), collisions (plane, box, sphere, cone),
integration, particle attributes and the usual math. Render: textures with frame animation and UV
tiling/rotation, gradients and color ramps, HSL adjustment, fresnel, dissolve, Depth Fade (soft
particles and intersection glows - the host gives each camera its scene depth, see the runtime's
README), normal maps, Lambert, Half-Lit and ambient shading, full matrix math, camera facing and
velocity alignment.

**Assets.** Images as textures, `.hdr` environments, `.glb` / `.gltf` meshes. The **Upload asset**
button on the Content screen takes a file and sends it to the right library by type.

**Lighting.** Manual Sun and Hemisphere lights, or an active HDRI environment that drives the
viewport background, a baked light probe, and Sun's auto-derived direction and color.

**Everything else.** Undo covers every action, uploads and preset loads included. Autosave to
`localStorage`. An approximate ALU **cost** per node. Light, auto and dark themes, mouse or touchpad
navigation, and an English, Russian or Ukrainian interface, with more locales to come.

| Shortcut                     | Action                            |
| ---------------------------- | --------------------------------- |
| `Ctrl+Z` / `Ctrl+Shift+Z`    | Undo / redo                       |
| `Ctrl+C` / `Ctrl+V`          | Copy / paste                      |
| `Ctrl+S`                     | Save project JSON                 |
| `Ctrl+Space`                 | Content screen                    |
| `Space`                      | Play / pause                      |
| `Left` / `Right`             | Step one frame                    |
| `A`                          | Add node (graph)                  |
| `C`                          | Add comment (graph)               |
| `G` / `R` / `S`              | Move / rotate / scale (viewport)  |
| `N`                          | Toggle transform panel (viewport) |
| `I`                          | Keyframe selection                |
| `F`                          | Frame / fit view                  |
| `Delete` / `Backspace` / `X` | Delete selection                  |

## Rendering and simulation

Graphs compile to two GLSL tiers: **Standard** (WebGL2) and **Baseline** (WebGL1-compatible). The
preview switches between them, and an export always carries both - the runtime picks by the
capabilities of the renderer it is given. The same nodes exist on both tiers, though the quality of some implementations depends on
the backend.

An emitter can additionally simulate on the GPU through transform feedback. That is enabled per
emitter (on by default) and needs a WebGL2 renderer at runtime. A graph that does not compile to a
GPU kernel runs on the JavaScript kernel, which is always compiled. This is the regular fallback
path.

## Export formats

**Project JSON** is the editable format: the whole authored document together with its assets. This
is what you hand to another artist.

**TypeScript export** is the shipping format: precompiled artifacts plus a thin subclass of the
runtime's effect class, importing only the runtime and a couple of three.js types.

## Limits

Known and deliberate, so you do not discover them mid-project:

- Environments are `.hdr` only, and drive the background and the baked light probe. No reflections,
  no PMREM. An environment stays part of the editor preview and never reaches the compiled result.
- A multi-mesh `.glb` decomposes into one asset per mesh. Uploaded meshes are baked into plain vertex
  arrays; materials and hierarchy are dropped on purpose, since the material comes from the render
  graph.
- A lit graph shades with the lights of the host scene - Lambert and Half-Lit with all of three's
  lights, ambient shading with the ambient, hemisphere and light-probe ones - so in a scene without
  them it comes out dark. The preview's own lighting rig is not exported.
- The **Embed assets** checkbox does nothing yet: the TypeScript export always takes its assets
  through the constructor.
- Projects travel as files. No share links, no cloud, no accounts.
- No performance measurements yet. The cost readout in the editor is a relative ALU estimate for
  comparing graphs; it cannot be read as frame time.

## Reporting bugs

The most useful thing is a short screen capture plus the project `.json` it reproduces on.

## Running locally

```sh
npm install
npm run dev     # rollup watch + dev server
npm run build   # bundle to dist/
```

`npm test` runs the Vitest suite; `npm run typecheck` and `npm run lint` cover the rest.

## License

MIT - use it in commercial work, client projects and ads that ship; keep the copyright notice. See
[LICENSE](LICENSE).
