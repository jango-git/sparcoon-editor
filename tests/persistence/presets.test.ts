import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deserializeProject } from "../../src/persistence/projectFile";
import { EMPTY_PRESET, PROJECT_PRESETS, SPARKS_PRESET } from "../../src/persistence/presets";
import { compileEmitter, compileMesh } from "../../src/persistence/exportCompile";

/**
 * `loadPresetSource` fetches its bundled JSON at runtime (`import.meta.url`-relative), which
 * Node's `fetch` doesn't serve for `file://` URLs - so this reads the checked-in file directly
 * and runs it through the same parser, to catch a shape regression without touching the network path.
 */
function readBundledPreset(fileName: string): string {
  return readFileSync(
    new URL(`../../src/persistence/presets/${fileName}`, import.meta.url),
    "utf8",
  );
}

describe("bundled project presets", () => {
  it("lists Empty first, then Sparks", () => {
    expect(PROJECT_PRESETS.map((preset) => preset.id)).toEqual(["empty", "sparks"]);
    expect(PROJECT_PRESETS[0]).toBe(EMPTY_PRESET);
  });

  it("every preset has a unique id", () => {
    const ids = PROJECT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the Sparks preset's bundled JSON parses to a valid document", () => {
    const source = deserializeProject(readBundledPreset(SPARKS_PRESET.fileName));
    expect(source).toBeDefined();
    expect(source?.name).toBe("Sparks");
    expect(source?.scene.emitters.length).toBeGreaterThan(0);
  });

  it("the Empty preset's bundled JSON parses to a valid document", () => {
    const source = deserializeProject(readBundledPreset(EMPTY_PRESET.fileName));
    expect(source).toBeDefined();
    expect(source?.name).toBe("Empty");
    expect(source?.scene.emitters.length).toBeGreaterThan(0);
  });

  it("every bundled preset's emitters and meshes actually compile, not just parse", () => {
    for (const preset of PROJECT_PRESETS) {
      const source = deserializeProject(readBundledPreset(preset.fileName));
      expect(source, preset.fileName).toBeDefined();
      for (const emitter of source!.scene.emitters) {
        expect(() => compileEmitter(emitter), `${preset.fileName}: ${emitter.name}`).not.toThrow();
      }
      for (const mesh of source!.scene.meshes) {
        expect(() => compileMesh(mesh), `${preset.fileName}: ${mesh.name}`).not.toThrow();
      }
    }
  });
});
