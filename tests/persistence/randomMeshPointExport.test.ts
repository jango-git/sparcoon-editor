import { describe, expect, it } from "vitest";

import { SPAWN_SINK_TYPE, SPAWN_TRY_GPU_SIMULATION_PARAM } from "../../src/domain/sinkMeta";
import type { EmitterDoc, MeshAsset, SourceState } from "../../src/model/editorState";
import { createDefaultEmitter, createInitialState } from "../../src/model/editorState";
import { emitProjectModule } from "../../src/persistence/exportTypeScript";

const MESH = "rock.glb #1";

const ROCK: MeshAsset = {
  name: MESH,
  label: MESH,
  geometry: {
    position: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array(),
    uv: new Float32Array(),
    index: Uint32Array.from([0, 1, 2]),
  },
  byteSize: 0,
};

/** A skinned {@link ROCK}: every vertex bound to its one bone. */
const ARM: MeshAsset = {
  ...ROCK,
  name: "arm",
  label: "arm",
  geometry: {
    ...ROCK.geometry,
    skin: {
      skinIndex: new Float32Array(12),
      skinWeight: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      bindMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      bones: [
        { name: "root", parent: -1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      ],
      boneInverses: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      clips: [],
    },
  },
};

/** The default emitter `id` spawning on `mesh` by the node `type` instead of its sphere,
 *  simulated on the GPU. */
function spawningOn(mesh: string, type = "random-mesh-point", id = "emitter_a"): EmitterDoc {
  const emitter = createDefaultEmitter(id, id);
  const nodes = Object.fromEntries(
    Object.values(emitter.behaviorGraph.nodes).map((node) => {
      if (node.id === "n_pos") {
        return [node.id, { ...node, type, parameters: { mesh } }];
      }
      if (node.type === SPAWN_SINK_TYPE) {
        return [
          node.id,
          { ...node, parameters: { ...node.parameters, [SPAWN_TRY_GPU_SIMULATION_PARAM]: true } },
        ];
      }
      return [node.id, node];
    }),
  );
  return { ...emitter, behaviorGraph: { ...emitter.behaviorGraph, nodes } };
}

function sourceWith(
  emitters: EmitterDoc | readonly EmitterDoc[],
  meshAssets: readonly MeshAsset[],
): SourceState {
  const { source } = createInitialState();
  const list = Array.isArray(emitters) ? emitters : [emitters as EmitterDoc];
  return {
    ...source,
    meshAssets,
    scene: { ...source.scene, emitters: list, activeEmitterId: list[0]?.id ?? source.scene.activeEmitterId },
  };
}

describe("exporting an emitter that spawns on a mesh", () => {
  it("asks the app for the mesh geometry by its name, quoted when it is no identifier", () => {
    const module = emitProjectModule(sourceWith(spawningOn(MESH), [ROCK]));
    expect(module).toContain(`  ${JSON.stringify(MESH)}: BufferGeometry;`);
    // Both the JS behavior and the GPU kernel name it.
    expect(module.match(/meshSurfaces: \{"[^"]+":"rock\.glb #1"\}/g)).toHaveLength(2);
  });

  it("refuses a mesh the content library does not hold", () => {
    expect(() => emitProjectModule(sourceWith(spawningOn(MESH), []))).toThrow(
      /No mesh asset "rock\.glb #1"/,
    );
  });

  it("asks for a mesh of the scene as a Mesh, and a skinned one as a SkinnedMesh", () => {
    const module = emitProjectModule(
      sourceWith(
        [
          spawningOn(MESH, "random-scene-mesh-point"),
          spawningOn("arm", "random-skinned-mesh-point", "emitter_b"),
        ],
        [ROCK, ARM],
      ),
    );
    expect(module).toContain(`  ${JSON.stringify(MESH)}: Mesh;`);
    expect(module).toContain("  arm: SkinnedMesh;");
    expect(module).toContain('import { type Mesh, type SkinnedMesh } from "three";');
    expect(module.match(/objectSurfaces: \{"[^"]+":"rock\.glb #1"\}/g)).toHaveLength(2);
    expect(module.match(/skinnedSurfaces: \{"[^"]+":"arm"\}/g)).toHaveLength(2);
  });

  it("asks once, as a Mesh, for a mesh sampled both as a shape and as a mesh of the scene", () => {
    const module = emitProjectModule(
      sourceWith(
        [spawningOn(MESH), spawningOn(MESH, "random-scene-mesh-point", "emitter_b")],
        [ROCK],
      ),
    );
    expect(module).toContain(`  ${JSON.stringify(MESH)}: Mesh;`);
    expect(module).not.toContain("BufferGeometry");
  });

  it("refuses a skinned mesh for a static mesh of the scene", () => {
    expect(() =>
      emitProjectModule(sourceWith(spawningOn("arm", "random-scene-mesh-point"), [ARM])),
    ).toThrow(/No static mesh asset "arm"/);
  });
});
