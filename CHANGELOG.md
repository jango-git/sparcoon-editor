# Changelog

Every notable change to the Sparcoon Editor, as it affects someone making effects in it. The
[site](https://jango-git.github.io/sparcoon-editor/) is updated on releases only. Changes to what
an exported effect needs from the game are in the
[runtime's changelog](https://github.com/jango-git/sparcoon/blob/main/CHANGELOG.md).

## Unreleased

### Added

- Ribbons: an emitter can have a ribbon graph, a band through its particles in the order they were
  born, beside its render and trail graphs. Its UV runs along it by each point's age over its
  lifetime or repeats every given number of particles. With Head on, while a play emits, the
  ribbon reaches on from its newest particle to the particle a birth would seed now. The ribbon is
  marked with a warning when bursts of several particles or reactions would weave it between births
  from different places, or when Head is on and no play would show it.
  The agent API turns it on with `scene.setRibbon` and edits it as the `"ribbon"` graph.
- Draw Particles on the render graph's surface: off, the particles are simulated but not drawn, for
  an emitter shown by its trail or ribbon alone. Such an emitter cannot sort, and one that draws
  nothing at all is marked with a warning.
- Sort Every works on GPU-simulated emitters, which used to report that depth sorting had no
  effect on them. A sorted emitter is rebuilt when sorting is turned on or off, and its render
  budget counts the reads of its particles from textures.
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
