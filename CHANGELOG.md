# Changelog

Every notable change to the Sparcoon Editor, as it affects someone making effects in it. The
[site](https://jango-git.github.io/sparcoon-editor/) is updated on releases only. Changes to what
an exported effect needs from the game are in the
[runtime's changelog](https://github.com/jango-git/sparcoon/blob/main/CHANGELOG.md).

## Unreleased

### Added

- Random Scene Mesh Point and Random Skinned Mesh Point give a random point on a mesh of the
  game's scene, in the world where the game draws it, a skinned one in the pose the game last drew
  it in, and the surface's velocity there. Wired into the spawn, the velocity sends a particle off
  with the surface's motion. In the update, with the particle's seed, a particle stays on its point
  of the moving surface.
- A mesh from a `.glb` keeps its place in the file, and a skinned one its skin, skeleton and the
  clips that move its bones. Its row picks the clip the preview plays at the timeline's time.
- A mesh's row shows the mesh in the preview scene, where its file places it.
- The agent API's `assets.setMeshPreview` sets whether a mesh is shown in the preview scene and the
  clip it plays, and `assets.list()` gives each mesh's settings and clips.

### Changed

- The bundled presets cost less to draw:
  - round planes use the octagon geometry;
  - Destruction's shockwave plane is shown only while its front runs, and its scorched foot is a
    plane of its own, 1 m across;
  - smoke and dust are shaded without a spherical normal;
  - Shield's dome reads its pattern by the mesh's UV, and its veil flows on one noise;
  - several noises use one octave;
  - trail fades are straight lines between their keys;
  - small debris casts no shadow;
  - Campfire's flames hold each frame of their sheet.
- The presets' preview scenes are one mesh with the colours in its vertices, drawn in one call
  (Shield's in two, its lights apart), and their boxes have no chamfers.
- A behavior graph computes only what its outputs read: an output of a node nothing reads, such as
  the normal of a Random Mesh Point placing particles by its position, costs nothing. A graph whose
  unread outputs draw random values draws other values for the rest, so its particles spawn at
  other points. Re-export effects to have the cheaper kernels.

## 0.7.0 - 2026-11-26

### Added

- The viewport's Camera tab shows the camera's position, the point it orbits and looks at, and its
  field of view, and moves the camera when they are edited.
- A saved project file holds the viewport camera, and opening it, or a preset with one, puts the
  camera there. A file without one opens with the default camera. Moving the camera is not an
  undo step. A reload keeps the camera where it was.
- The bundled presets open with the camera set on their effect.

### Changed

- The viewport camera orbits up to 50 units from the point it looks at, was 30.

### Fixed

- The project name field takes the width of the Project block, so long names fit.

## 0.6.0 - 2026-11-26

### Added

- A ribbon's Section splits it into ribbons of that many particles each, 2 to 256, so one burst of
  that many draws one ribbon. A warning shows while a spawn of the emitter is not a burst of a
  multiple of it.
- Agent API version 4: `preview.getView()` gives the viewport camera's position, the point it
  orbits and looks at, and its field of view, and `preview.setView({ position, target, fov })`
  places it there. `comment(ownerId, graph, text, { nodes, comments })` gathers nodes and comments
  into a new comment, which `arrange()` then lays out as one block.
- Random Mesh Point has Seed and Salt inputs, as Hash has: the same seed and salt give the same
  point, in either phase and in any emitter. The seed defaults to the particle's.

### Removed

- The Void scene. A project saved with it opens with the studio ground, and the agent API's
  `assets.setScene("void")` throws as for any unknown scene.

### Changed

- Random Mesh Point in the update keeps a particle's point instead of drawing a new one every
  frame. A seed that changes with time draws a new one.
- Arrange keeps the comments. Each is laid out as one block round the nodes it holds, with nested
  comments inside it, and a comment holding no node is removed. Parts of a graph that no wire joins
  are kept next to each other.
- Campfire, Destruction, Energy Shield, Fireflies, Lightning Crack and Sparks come with preview
  scenes, which stay in the editor and are not exported. The presets' graphs carry comments naming
  their stages.
- Sparks bounces off the preview scene through Depth Sample instead of off a ground plane, so it
  runs on the GPU simulation only.
- Campfire burns under a tent. Its smoke slides along the tarp, and its embers and sparks collide
  with it, through an SDF of the tarp.
- Destruction's debris, sparks, dust and shockwave stop at the walls of a ruined house through an
  SDF of the walls, and its pillar stands from the first frame.
- Energy Shield discharges arcs into the objects round its pad, has a flowing sheet under the
  hexagons, and throws off smoke and sparks at each hit.
- Lightning Crack's storm walks a closed 16 s loop, so its timeline loops instead of playing
  forever.
- Fireflies fly round the trees, kept off the trunks by an SDF, and land back on their rock. The
  flock is 3072 instead of 2500.
- Portal draws its sparks in from a funnel in front of it, and has concrete grit crawling to its
  foot and concrete shards hanging round it.
- The preview's lights are brighter by default: the sun at 4 instead of 2.2, the sky and ground
  fill at 2 instead of 0.7.

### Fixed

- A node card is as wide in Firefox as in Chromium, so a graph arranged in one keeps its wires
  straight in the other.
- The type of a behavior sink's attribute shows in full instead of cut off.
- Arrange no longer runs two wires along one stretch where they swap rows between columns, as it
  did in the Portal's Grit trail.
- Destruction's shockwave no longer lights up the square of ground it never reaches as it fades.
- On the GPU a spawn graph reads the newborn's own slot: its id, its birth age and zero for the
  rest, as on the CPU. It used to read the state of the particle the slot held before, so a Read
  State of the id, or a Hash or Random Mesh Point left on its default seed, gave every newborn of
  a burst the same value on the emitter's first lap.

## 0.5.0 - 2026-11-25

### Added

- Preview scenes. A `.glb` dropped on the **Scenes** section of the Content screen is drawn around
  the effect in place of the studio ground, with its own materials, and the viewport's Scene tab
  picks it, **Studio** or **Void**. Shadows fall on it, and Depth Fade and Depth Sample read its
  depth. Scenes are saved in the project and never reach the TypeScript export.
- Meshes and scenes load from meshopt-compressed files.

### Changed

- The project file stores HDRIs, scenes and mesh geometry gzipped. Mesh geometry takes about an
  eighth of the space it did. A project saved by this version does not open in an earlier one.
- The Ground switch of the viewport's Scene tab is gone: the **Void** scene shows no ground.
- Agent API version 3: `project.get()` returns a promise, a capture keeps the scene with
  `scene: true` instead of `ground: true`, and `assets` has `addScene(fileName, data)` and
  `setScene(name)`.
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
- The Lightning Crack lays its crack segments twice as densely along the path, so the crack reads
  as one split instead of separate pieces.

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
