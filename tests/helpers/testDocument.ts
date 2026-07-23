import {
  createDefaultEmitter,
  createDefaultVfx,
  DEFAULT_TIMELINE,
  type EditorState,
} from "../../src/model/editorState";

/**
 * A document with one real, compilable starter emitter (constant albedo + billboard transform,
 * sphere spawn + lifetime) - what a fresh document looked like before "Empty" became the actual
 * initial state. Most tests want a working default to exercise, not the genuinely blank document
 * `createInitialState()` now produces (see `tests/editor/defaultEmitter.test.ts`), so they build
 * their fixture from here instead.
 */
export function createTestState(): EditorState {
  const emitter = createDefaultEmitter("emitter_1", "Emitter");
  return {
    source: {
      name: "",
      scene: {
        vfx: createDefaultVfx("vfx_1"),
        emitters: [emitter],
        activeEmitterId: emitter.id,
        meshes: [],
        activeGraphKind: "emitter",
      },
      assets: [],
      environments: [],
      activeEnvironmentName: undefined,
      meshAssets: [],
      timeline: DEFAULT_TIMELINE,
    },
    derived: {},
  };
}
