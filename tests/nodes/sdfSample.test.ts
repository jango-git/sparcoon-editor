import { FX_VOLUME_HEADER_FLOATS } from "sparcoon";
import { describe, expect, it } from "vitest";

import type { FXBehaviorNode } from "../../src/engine/behavior/FXBehaviorNode";
import { compileBehaviorBundle } from "../../src/engine/behavior/FXCompiledBehaviorBundle";
import { compileParticleBehavior } from "../../src/engine/behavior/FXParticleBehaviorKernel.Internal";
import { particleBehaviorTargetsFor } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import type { FXGraph } from "../../src/engine/core/FXGraph";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import {
  behaviorArtifactBody,
  gpuKernelArtifactBody,
} from "../../src/engine/emit/artifactLiterals";
import {
  assembleBehaviorArtifact,
  assembleGpuKernelArtifact,
} from "../../src/engine/emit/assembleArtifacts";
import { FX_STANDARD_NODES } from "../../src/engine/nodes-std";
import { VOLUME_DESCRIPTION_KEYS } from "../../src/model/editorState";
import { attributeSlot, storeAttr } from "../helpers/attr";
import { bind, buffersFor, edge, fieldUpdateKernel, graphOf } from "../helpers/graphBuild";
import { fullBehaviorRegistry } from "../helpers/stdRegistry";

const reg = fullBehaviorRegistry();
const VEC3 = FX_VALUE_TYPES.vec3;
const FLOAT = FX_VALUE_TYPES.float;

const SIZE = 32;
const RADIUS = 0.5;

/** The volume table of a sphere of `RADIUS` at the origin, over the box from -1 to 1, its
 *  distance encoded as `byte / 255 * 2 - 1` - the layout the runtime builds from an R8 texture. */
function sphereTable(): Float32Array {
  const table = new Float32Array(FX_VOLUME_HEADER_FLOATS + SIZE ** 3);
  table.set([SIZE, SIZE, SIZE]);
  const centre = (index: number): number => -1 + ((index + 0.5) * 2) / SIZE;
  for (let z = 0; z < SIZE; z++) {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const distance = Math.hypot(centre(x), centre(y), centre(z)) - RADIUS;
        const byte = Math.round(Math.min(Math.max((distance + 1) / 2, 0), 1) * 255);
        table[FX_VOLUME_HEADER_FLOATS + x + SIZE * (y + SIZE * z)] = byte / 255;
      }
    }
  }
  return table;
}

/** An SDF Sample of volume `volume` at the particle's position, storing its distance and normal. */
function sampling(volume = "field"): FXGraph<FXBehaviorNode> {
  return graphOf(
    {
      sdf: reg.create("sdf-sample", { volume, scale: 2, bias: -1 }),
      d: storeAttr("d", FLOAT),
      n: storeAttr("n", VEC3),
    },
    [edge("sdf", "distance", "d", "value"), edge("sdf", "normal", "n", "value")],
    [bind(attributeSlot("d"), "d", "value"), bind(attributeSlot("n"), "n", "value")],
  );
}

/** The distance and normal an update reads at `position`, with the sphere's table bound. */
function sampleAt(position: readonly number[]): { distance: number; normal: number[] } {
  const compiled = compileParticleBehavior(sampling());
  const binding = Object.keys(compiled.update.volumes ?? {})[0] ?? "";
  expect(binding).not.toBe("");
  const buffers = buffersFor(compiled);
  buffers["position"].set(position);
  fieldUpdateKernel(compiled)(buffers, 1, 0.016, {
    ...compiled.update.bindings,
    [binding]: { name: binding, value: sphereTable() },
  });
  return { distance: buffers["d"][0], normal: [...buffers["n"]] };
}

describe("sdf-sample", () => {
  it("reads the distance to the surface and the outward normal there", () => {
    const outside = sampleAt([0.75, 0, 0]);
    expect(outside.distance).toBeCloseTo(0.25, 1);
    expect(outside.normal[0]).toBeCloseTo(1, 2);
    expect(Math.hypot(...outside.normal)).toBeCloseTo(1, 5);

    const tilted = sampleAt([0, 0.5, 0.5]);
    expect(tilted.distance).toBeCloseTo(Math.SQRT1_2 - RADIUS, 1);
    expect(tilted.normal[1]).toBeCloseTo(Math.SQRT1_2, 1);
    expect(tilted.normal[2]).toBeCloseTo(Math.SQRT1_2, 1);

    expect(sampleAt([0, 0, 0.1]).distance).toBeCloseTo(0.1 - RADIUS, 1);
  });

  it("adds the distance to the box outside it", () => {
    const edge = sampleAt([1, 0, 0]).distance;
    expect(sampleAt([3, 0, 0]).distance).toBeCloseTo(edge + 2, 5);
  });

  it("declares its volume as a resource of both artifacts, not as a value binding", () => {
    const graph = sampling();
    const bundle = compileBehaviorBundle(graph, particleBehaviorTargetsFor(graph, true));
    const program = bundle.standardProgram;
    expect(program).toBeDefined();
    if (program === undefined) {
      return;
    }
    const [uniform] = Object.keys(program.volumes ?? {});
    expect(program.volumes).toEqual({ [uniform]: "field" });
    expect(program.vertexSource).toContain("precision highp sampler3D;");
    expect(program.vertexSource).toContain(`uniform sampler3D ${uniform};`);
    expect(program.vertexSource).toContain("textureSize(");
    expect(Object.keys(program.bindings)).not.toContain(uniform);
    expect(assembleGpuKernelArtifact(program).volumes).toEqual({ [uniform]: "field" });
    expect(gpuKernelArtifactBody(program)).toContain(
      `volumes: ${JSON.stringify({ [uniform]: "field" })},`,
    );

    const behavior = assembleBehaviorArtifact(bundle.kernel);
    const [binding] = Object.keys(behavior.volumes ?? {});
    expect(behavior.volumes).toEqual({ [binding]: "field" });
    expect(behavior.meshSurfaces).toBeUndefined();
    expect(behaviorArtifactBody(bundle.kernel)).toContain(
      `volumes: ${JSON.stringify({ [binding]: "field" })},`,
    );
  });

  it("puts the surface infinitely far and declares no volume while none is picked", () => {
    const graph = sampling("");
    const compiled = compileParticleBehavior(graph);
    expect(compiled.update.volumes).toBeUndefined();
    const buffers = buffersFor(compiled);
    fieldUpdateKernel(compiled)(buffers, 1, 0.016, compiled.update.bindings);
    expect(buffers["d"][0]).toBe(1e6);
    expect([...buffers["n"]]).toEqual([0, 1, 0]);
  });

  it("names the volume it samples and recompiles on another pick", () => {
    const picked = reg.create("sdf-sample", { volume: "field" });
    expect(picked.assetReads).toEqual([{ kind: "volume", name: "field" }]);
    expect(reg.create("sdf-sample", {}).assetReads).toEqual([]);
    expect(picked.cacheKey?.()).not.toBe(
      reg.create("sdf-sample", { volume: "other" }).cacheKey?.(),
    );
  });

  it("takes as inputs, of the same types, what a volume asset says about its texels", () => {
    const inputs = new Map(
      (FX_STANDARD_NODES.find((node) => node.type === "sdf-sample")?.describe().inputs ?? []).map(
        (input) => [input.key, input.type],
      ),
    );
    const types: Record<(typeof VOLUME_DESCRIPTION_KEYS)[number], string> = {
      boxMin: "vec3",
      boxMax: "vec3",
      scale: "float",
      bias: "float",
    };
    for (const key of VOLUME_DESCRIPTION_KEYS) {
      expect(inputs.get(key), key).toBe(types[key]);
    }
  });
});
