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

/** The default emitter spawning on `mesh` instead of its sphere, simulated on the GPU. */
function spawningOn(mesh: string): EmitterDoc {
  const emitter = createDefaultEmitter("emitter_a", "A");
  const nodes = Object.fromEntries(
    Object.values(emitter.behaviorGraph.nodes).map((node) => {
      if (node.id === "n_pos") {
        return [node.id, { ...node, type: "random-mesh-point", parameters: { mesh } }];
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

function sourceWith(emitter: EmitterDoc, meshAssets: readonly MeshAsset[]): SourceState {
  const { source } = createInitialState();
  return {
    ...source,
    meshAssets,
    scene: { ...source.scene, emitters: [emitter], activeEmitterId: emitter.id },
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
});
