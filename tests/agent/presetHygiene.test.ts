import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveGraph, targetGraph } from "../../src/agent/address.Internal";
import { placedNodeMeta, requireParameterKeys } from "../../src/agent/references.Internal";
import { deserializeProject } from "../../src/persistence/projectFile";

const PRESET_DIRECTORY = "src/persistence/presets";

/** Every parameter a preset's node carries that its node type does not store. */
function strayParameters(fileName: string): string[] {
  const source = deserializeProject(readFileSync(`${PRESET_DIRECTORY}/${fileName}`, "utf8"));
  expect(source).toBeDefined();
  const owners = [
    ...source!.scene.emitters.flatMap((emitter) => [
      { id: emitter.id, graph: "render" as const },
      { id: emitter.id, graph: "behavior" as const },
    ]),
    ...source!.scene.meshes.map((mesh) => ({ id: mesh.id, graph: "render" as const })),
  ];
  const stray: string[] = [];
  for (const owner of owners) {
    const target = resolveGraph(source!, owner.id, owner.graph);
    const graph = targetGraph(source!, target);
    for (const node of Object.values(graph.nodes)) {
      try {
        requireParameterKeys(placedNodeMeta(source!, target, graph, node), node.parameters);
      } catch (error) {
        stray.push(`${owner.id}/${owner.graph}/${node.id}: ${(error as Error).message}`);
      }
    }
  }
  return stray;
}

describe("bundled presets", () => {
  // A stale key is ignored by the engine but reads as a real setting to anyone inspecting the
  // preset (an agent took Sparks' leftover `material: "unlit"` for a lit/unlit switch).
  it.each(readdirSync(PRESET_DIRECTORY).filter((name) => name.endsWith(".json")))(
    "%s carries only parameters its nodes store",
    (fileName) => {
      expect(strayParameters(fileName)).toEqual([]);
    },
  );
});
