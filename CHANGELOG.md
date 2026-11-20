# Changelog

Every notable change to the Sparcoon Editor, as it affects someone making effects in it. The
[site](https://jango-git.github.io/sparcoon-editor/) is updated on releases only. Changes to what
an exported effect needs from the game are in the
[runtime's changelog](https://github.com/jango-git/sparcoon/blob/main/CHANGELOG.md).

## Unreleased

### Changed

- The presets draw fewer layers where they used to slow a close camera down. The smoke and dust of
  Lightning Crack, Destruction, Fireworks and Portal are fewer, denser puffs that die once they
  have faded, and soft smoke sorts every 10 frames instead of every 2. Up close the Lightning
  Crack draws about half the layers it did, the Destruction cloud about two thirds.
- In Lightning Crack the flash and the light on the ground are one particle each for the lap
  instead of a stream of short ones stacked over each other, and the flash has no size between
  strikes. The Destruction shockwave is not drawn outside the blast.
- The Shield dome is drawn on a half sphere, the `Dome` mesh in its library, instead of a whole
  sphere with the lower half cut away. Its shards have no size until they break off.
- The Campfire smoke holds each frame of its sheet instead of blending two, the Portal horizon's
  swirl takes 6 noise octaves instead of 8, and the Sparks preset casts no shadow.

## 0.4.0 - 2026-11-20

### Changed

- On the CPU simulation the random values of an emitter repeat from run to run, as on the GPU. A
  replay of the same frame times spawns the same particles. A Random in the update still draws
  another value every frame. An effect gets it once re-exported, and needs the runtime of the
  same release.
- On a phone or tablet without a mouse, Example effects leads to the
  [examples page](https://jango-git.github.io/sparcoon/), where the effects play in the browser.

### Fixed

- A project saved before 24 July 2026 with Read Attribute nodes opens with them as Builtin Attribute
  or Custom Attribute nodes, and a Read Attribute Components node as Custom Attribute Split. Before,
  they stayed in the graph with an error and the effect did not export.

## 0.3.0 - 2026-11-19

### Changed

- An edit that rebuilds an emitter simulated on the GPU no longer pauses the preview while the new
  simulation program builds. The previous emitter runs until it has built, then the new one takes
  over.
- A GPU simulation program the driver rejects shows as an error of the behavior graph. Before, the
  preview switched to the CPU simulation without saying so.

## 0.2.1 - 2026-11-19

### Fixed

- The editor loads again. 0.2.0 stopped at start with `process is not defined`.

## 0.2.0 - 2026-11-18

### Changed

- On the CPU simulation the update skips dead particles, as the GPU one does. The saving is
  largest for graphs with noise on mostly empty emitters. An effect gets it once re-exported.
- An exported effect imports its GLSL helpers from `sparcoon/helpers`, as it does its CPU math and
  noise, instead of carrying its own copy of each.
- An emitter or a mesh gets a shadow program only with Cast Shadow on: an export without it holds
  none. In a project of 15 effects the two changes take the effects from 1063 KB to 702 KB
  minified. An effect gets them once re-exported.

### Fixed

- A removed Timeline Value no longer stays live in the export as a parameter that sets nothing,
  and a mesh's one no longer leaves its keys behind.
- Renaming a Timeline Value that another node also reads leaves that node its keys and live mark.
- A graph whose shader the GPU driver rejects shows as an error with the first line of the driver's
  message, in the graph panel and in the agent's `status()`. Before, it showed as working and drew
  nothing.

## 0.1.0 - 2026-11-15

### Added

- An emitter can have a ribbon graph beside its render and trail graphs. The ribbon is a band
  through its particles in the order they were born. Its UV runs along it by each point's age over
  its lifetime or repeats every given number of particles. With Head on, while a play emits, the
  ribbon reaches on from its newest particle to the particle a birth would seed now. The ribbon is
  marked with a warning when bursts of several particles or reactions would weave it between births
  from different places, or when Head is on and no play would show it.
  The agent API turns it on with `scene.setRibbon` and edits it as the `"ribbon"` graph.
- Draw Particles on the render graph's surface. Turned off, the particles are simulated but not
  drawn, for an emitter shown by its trail or ribbon alone. Such an emitter cannot sort, and one
  that draws nothing at all is marked with a warning.
- Sort Every works on GPU-simulated emitters, which used to report that depth sorting had no
  effect on them. A sorted emitter is rebuilt when sorting is turned on or off, and its render
  budget counts the reads of its particles from textures.
- The SDF Sample node gives the signed distance from a point to a surface and the outward normal
  there, read from a volume asset. Field Collision bounces particles off any surface given by such
  a distance and normal. Both run in the simulation on either backend.
- A mesh asset bakes into a volume asset (an SDF) on the baker screen its row on the Content screen
  opens. The box, resolution, distance band and solid or shell mode are set there, beside a 3D view
  of the mesh and the box, and the bake shows in it as the surface it holds at a chosen distance
  before it is added to the library. Picking a volume in an SDF Sample sets the node's box and
  distance encoding from the bake. A volume downloads as a PNG atlas of its slices, and an exported
  effect takes it from the game as an R8 `Data3DTexture`. The agent API bakes one with
  `assets.bakeVolume`.
- The Depth Sample node gives the signed distance from a point to the rendered scene and the
  normal there, read from the camera's depth of the frame before, so Field Collision bounces
  particles off whatever the scene holds. It runs only in the GPU simulation, and the node is
  marked with a warning on an emitter simulated on the CPU. An exported effect with it needs the
  scene depth from the game, as Depth Fade does, and `camera`.
- Export zip on the Content screen downloads the library's images, meshes as GLB and volumes as
  PNG atlases in one archive, each file named as in the library. HDRIs are left out. The agent API
  gives the archive with `project.exportZip`.
- A project names the editor version that saved it. A project file saved in a later project format
  does not open, with a message naming that version, instead of opening with what this version
  does not know left out.

### Changed

- The presets simulate every emitter on the GPU that can be, sort only the emitters that blend
  (smoke, dust and similar), and the emitters' capacities fit the most particles each one has alive
  at once.
- In the Portal preset the sparks drawn into the portal leave a trail of the spiral they come in
  along.
- The autosaved project is stored in the same format as the project file.
- A mesh's row on the Content screen counts its users - the nodes sampling it and the surfaces
  drawing it - as a texture's row does.

### Fixed

- Global and Local in the Gizmo settings show their tooltips.
