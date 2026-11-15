# Changelog

Every notable change to the Sparcoon Editor, as it affects someone making effects in it. The
[site](https://jango-git.github.io/sparcoon-editor/) is updated on releases only. Changes to what
an exported effect needs from the game are in the
[runtime's changelog](https://github.com/jango-git/sparcoon/blob/main/CHANGELOG.md).

## Unreleased

### Added

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
- The autosaved project is stored in the same format as the project file.
