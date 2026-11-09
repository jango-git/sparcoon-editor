import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deserializeProject } from "../../src/persistence/projectFile";
import { EMPTY_PRESET, PROJECT_PRESETS, SPARKS_PRESET } from "../../src/persistence/presets";
import { compileEmitter, compileMesh } from "../../src/persistence/exportCompile";

/**
 * `loadPresetSource` fetches its bundled JSON at runtime (`import.meta.url`-relative), which
 * Node's `fetch` doesn't serve for `file://` URLs - so this reads the checked-in file directly
 * and runs it through the same parser, to catch a shape regression without touching the network path.
 */
const PRESETS_DIRECTORY = new URL("../../src/persistence/presets/", import.meta.url);

function readBundledPreset(fileName: string): string {
  return readFileSync(new URL(fileName, PRESETS_DIRECTORY), "utf8");
}

describe("bundled project presets", () => {
  it("lists Empty first (the start-over option), then Sparks, ahead of the showcase effects", () => {
    // The only ordering contract: the menu opens with Empty and Sparks; the showcase order is free.
    expect(PROJECT_PRESETS[0]).toBe(EMPTY_PRESET);
    expect(PROJECT_PRESETS[1]).toBe(SPARKS_PRESET);
  });

  it("lists every bundled preset JSON exactly once", () => {
    const bundled = readdirSync(PRESETS_DIRECTORY).filter((name) => name.endsWith(".json"));
    expect(PROJECT_PRESETS.map((preset) => preset.fileName).sort()).toEqual(bundled.sort());
  });

  it("every preset has a unique id", () => {
    const ids = PROJECT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every bundled preset's JSON parses to a document with something in it", () => {
    for (const preset of PROJECT_PRESETS) {
      const source = deserializeProject(readBundledPreset(preset.fileName));
      expect(source, preset.fileName).toBeDefined();
      expect(source!.scene.emitters.length, preset.fileName).toBeGreaterThan(0);
    }
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
