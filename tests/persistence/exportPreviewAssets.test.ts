import { describe, expect, it } from "vitest";

import { createDefaultEmitter, createInitialState } from "../../src/model/editorState";
import { emitProjectModule } from "../../src/persistence/exportTypeScript";

describe("the TypeScript export", () => {
  it("is the same with or without HDRIs and preview scenes", () => {
    const base = createInitialState().source;
    const plain = {
      ...base,
      name: "Effect",
      scene: { ...base.scene, emitters: [createDefaultEmitter("emitter_1", "Emitter")] },
    };
    const surrounded = {
      ...plain,
      environments: [
        { name: "sky", label: "sky.hdr", bytes: Uint8Array.from([1, 2, 3]), byteSize: 3 },
      ],
      activeEnvironmentName: "sky",
      scenes: [
        { name: "arena", label: "arena.glb", bytes: Uint8Array.from([4, 5, 6]), byteSize: 3 },
      ],
      activeSceneName: "arena",
    };
    expect(emitProjectModule(surrounded)).toBe(emitProjectModule(plain));
  });
});
