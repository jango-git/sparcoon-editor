import { FXWorld } from "sparcoon";
import { FXEmitter } from "sparcoon/editor";
import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import { compileBehaviorBundle } from "../../src/engine/behavior/FXCompiledBehaviorBundle";
import { particleBehaviorTargetsFor } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import {
  behaviorArtifactBody,
  gpuKernelArtifactBody,
} from "../../src/engine/emit/artifactLiterals";
import {
  assembleBehaviorArtifact,
  assembleGpuKernelArtifact,
} from "../../src/engine/emit/assembleArtifacts";
import { unlitArtifact } from "../helpers/artifacts";
import { bind, graphOf } from "../helpers/graphBuild";
import { fullBehaviorRegistry } from "../helpers/stdRegistry";

const reg = fullBehaviorRegistry();

/** A graph spawning each particle at the random-mesh-point `output` (position or normal). */
function graphPlacingAt(output: "position" | "normal", mesh = "rock") {
  return graphOf(
    {
      mesh: reg.create("random-mesh-point", { mesh }),
      life: reg.create("lifetime", { min: 5, max: 5 }),
    },
    [],
    [bind("position", "mesh", output, "spawn"), bind("lifetime", "life", "value", "spawn")],
  );
}

// Two triangles on z = 0: area 0.5 near the origin, area 4.5 around x = 10. Normals tilt the
// second one's corners, unnormalized.
function rock(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 13, 0, 0, 10, 3, 0]),
      3,
    ),
  );
  geometry.setAttribute(
    "normal",
    new BufferAttribute(
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, 2, 0, 0, 2]),
      3,
    ),
  );
  return geometry;
}

/** Where `count` newborns land on the CPU, read through the behavior's spawn as it runs. */
function spawnedPositions(output: "position" | "normal", count: number): number[][] {
  const { kernel } = compileBehaviorBundle(
    graphPlacingAt(output),
    particleBehaviorTargetsFor(graphPlacingAt(output)),
  );
  const behavior = assembleBehaviorArtifact(kernel);
  const stride = behavior.buffers.reduce((sum, buffer) => sum + buffer.stride, 0);
  let offset = 0;
  for (const buffer of behavior.buffers) {
    if (buffer.name === "position") {
      break;
    }
    offset += buffer.stride;
  }
  const positions: number[][] = [];
  const spawn = behavior.spawn;
  const emitter = FXEmitter.fromArtifacts(
    {
      ...behavior,
      spawn(slots, start, births, ...rest): void {
        spawn?.(slots, start, births, ...rest);
        for (let i = start; i < start + births; i += 1) {
          positions.push([...slots.subarray(i * stride + offset, i * stride + offset + 3)]);
        }
      },
    },
    { particles: unlitArtifact(), geometries: { rock: rock() }, expectedCapacity: count },
  );
  try {
    emitter.burst(count);
    FXWorld.update(0);
  } finally {
    emitter.destroy();
  }
  return positions;
}

describe("random-mesh-point", () => {
  it("places newborns on the mesh in proportion to triangle area", () => {
    const positions = spawnedPositions("position", 4000);
    expect(positions).toHaveLength(4000);
    let onLarge = 0;
    for (const [x, y, z] of positions) {
      expect(z).toBeCloseTo(0, 6);
      if (x >= 10 - 1e-6) {
        onLarge += 1;
        expect(x - 10 + y).toBeLessThanOrEqual(3 + 1e-5);
      } else {
        expect(x + y).toBeLessThanOrEqual(1 + 1e-5);
      }
      expect(Math.min(x, y)).toBeGreaterThanOrEqual(-1e-6);
    }
    expect(onLarge / positions.length).toBeGreaterThan(0.87);
    expect(onLarge / positions.length).toBeLessThan(0.93);
  });

  it("gives the normalized normal there", () => {
    for (const [x, y, z] of spawnedPositions("normal", 50)) {
      expect([x, y, z].map((c) => Math.round(c * 1e5) / 1e5)).toEqual([0, 0, 1]);
    }
  });

  it("declares its mesh as a surface of both artifacts, not as a value binding", () => {
    const graph = graphPlacingAt("position");
    const bundle = compileBehaviorBundle(graph, particleBehaviorTargetsFor(graph, true));
    const program = bundle.standardProgram;
    expect(program).toBeDefined();
    if (program === undefined) {
      return;
    }
    const [uniform] = Object.keys(program.meshSurfaces ?? {});
    expect(program.meshSurfaces).toEqual({ [uniform]: "rock" });
    expect(program.vertexSource).toContain("precision highp sampler2D;");
    expect(program.vertexSource).toContain(`uniform sampler2D ${uniform};`);
    expect(program.vertexSource).toContain("texelFetch(");
    expect(Object.keys(program.bindings)).not.toContain(uniform);
    expect(assembleGpuKernelArtifact(program).meshSurfaces).toEqual({ [uniform]: "rock" });
    expect(gpuKernelArtifactBody(program)).toContain(
      `meshSurfaces: ${JSON.stringify({ [uniform]: "rock" })},`,
    );

    const behavior = assembleBehaviorArtifact(bundle.kernel);
    const [binding] = Object.keys(behavior.meshSurfaces ?? {});
    expect(behavior.meshSurfaces).toEqual({ [binding]: "rock" });
    expect(Object.keys(behavior.bindings)).not.toContain(binding);
    expect(behaviorArtifactBody(bundle.kernel)).toContain(
      `meshSurfaces: ${JSON.stringify({ [binding]: "rock" })},`,
    );
  });

  it("spawns at the origin and declares no surface while no mesh is picked", () => {
    const graph = graphPlacingAt("position", "");
    const bundle = compileBehaviorBundle(graph, particleBehaviorTargetsFor(graph, true));
    expect(assembleBehaviorArtifact(bundle.kernel).meshSurfaces).toBeUndefined();
    expect(bundle.standardProgram?.meshSurfaces).toBeUndefined();
  });
});
