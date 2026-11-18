# Changelog

Every notable change to the Sparcoon Editor, as it affects someone making effects in it. The
[site](https://jango-git.github.io/sparcoon-editor/) is updated on releases only. Changes to what
an exported effect needs from the game are in the
[runtime's changelog](https://github.com/jango-git/sparcoon/blob/main/CHANGELOG.md).

## Unreleased

### Changed

- On the CPU simulation the update skips dead particles, as the GPU one does. The saving is
  largest for graphs with noise on mostly empty emitters. An effect gets it once re-exported.

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
