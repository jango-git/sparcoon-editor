import { FX_OBJECT_ENTRIES, FXWorld } from "sparcoon";
import { FXEmitter } from "sparcoon/editor";
import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";

import { compileBehaviorBundle } from "../../src/engine/behavior/FXCompiledBehaviorBundle";
import { fusedVertexSource } from "../../src/engine/behavior/FXKernelBuildStandard.Internal";
import { particleBehaviorTargetsFor } from "../../src/engine/behavior/FXParticleBehaviorTarget";
import {
  assembleBehaviorArtifact,
  assembleGpuKernelArtifact,
} from "../../src/engine/emit/assembleArtifacts";
import { unlitArtifact } from "../helpers/artifacts";
import { bind, edge, graphOf } from "../helpers/graphBuild";
import { fullBehaviorRegistry } from "../helpers/stdRegistry";

const reg = fullBehaviorRegistry();

type FXNode = "random-mesh-point" | "random-scene-mesh-point" | "random-skinned-mesh-point";
type FXOutput = "position" | "normal" | "velocity";

/** A graph spawning each particle at the `output` of a `node` on the asset "arm", all of one
 *  seed. */
function graphPlacingAt(node: FXNode, output: FXOutput) {
  return graphOf(
    {
      mesh: reg.create(node, { mesh: "arm" }),
      life: reg.create("lifetime", { min: 5, max: 5 }),
      seed: reg.create("constant", { type: "vec3", value: [3, 1, 4] }),
    },
    [edge("seed", "out", "mesh", "seed")],
    [bind("position", "mesh", output, "spawn"), bind("lifetime", "life", "value", "spawn")],
  );
}

const CORNERS = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0)];

function triangle(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setFromPoints(CORNERS);
  geometry.setAttribute(
    "normal",
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
  );
  return geometry;
}

/**
 * {@link triangle} bound to two bones, the mesh placed at x = 2. Bound with an identity bind
 * matrix, as GLTFLoader binds before the world matrices are updated, it is drawn at x = 0;
 * bound after, at x = 2.
 */
function arm(boundBeforeWorld = false): SkinnedMesh {
  const geometry = triangle();
  geometry.setAttribute(
    "skinIndex",
    new BufferAttribute(new Uint16Array([0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new BufferAttribute(new Float32Array([1, 0, 0, 0, 0.25, 0.75, 0, 0, 1, 0, 0, 0]), 4),
  );
  const mesh = new SkinnedMesh(geometry);
  const root = new Bone();
  const tip = new Bone();
  tip.position.y = 1;
  root.add(tip);
  mesh.add(root);
  mesh.position.x = 2;
  mesh.updateMatrixWorld(true);
  const skeleton = new Skeleton([root, tip]);
  mesh.bind(skeleton, boundBeforeWorld ? new Matrix4() : undefined);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** {@link triangle} at (2, 0, 1), turned about z and stretched along x. */
function rock(): Mesh {
  const mesh = new Mesh(triangle());
  mesh.position.set(2, 0, 1);
  mesh.rotation.z = 0.5;
  mesh.scale.set(3, 1, 1);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Bends the arm and poses its skeleton, as three's render would. */
function pose(mesh: SkinnedMesh): void {
  const [root, tip] = mesh.skeleton.bones;
  root.rotation.set(0, 0, 0.4);
  tip.rotation.set(0.3, 0, -0.7);
  tip.position.set(0.2, 1, 0);
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
}

/** What the newborns of `run` read at `output` of `node` on the CPU; `run` calls `birth` for one. */
function newbornsReading(
  node: FXNode,
  output: FXOutput,
  mesh: Mesh,
  run: (birth: () => void) => void,
): Vector3[] {
  const graph = graphPlacingAt(node, output);
  const { kernel } = compileBehaviorBundle(graph, particleBehaviorTargetsFor(graph));
  const behavior = assembleBehaviorArtifact(kernel);
  const stride = behavior.buffers.reduce((sum, buffer) => sum + buffer.stride, 0);
  let offset = 0;
  for (const buffer of behavior.buffers) {
    if (buffer.name === "position") {
      break;
    }
    offset += buffer.stride;
  }
  const read: Vector3[] = [];
  const spawn = behavior.spawn;
  const emitter = FXEmitter.fromArtifacts(
    {
      ...behavior,
      spawn(slots, start, births, ...rest): void {
        spawn?.(slots, start, births, ...rest);
        read.push(new Vector3().fromArray(slots, start * stride + offset));
      },
    },
    {
      particles: unlitArtifact(),
      geometries: { arm: mesh.geometry },
      meshes: { arm: mesh },
      expectedCapacity: 4,
    },
  );
  try {
    run(() => {
      emitter.burst(1);
      FXWorld.update(0);
    });
  } finally {
    emitter.destroy();
  }
  return read;
}

/** What one newborn reads at `output` of `node`. */
function newbornReading(node: FXNode, output: FXOutput, mesh: Mesh): Vector3 {
  return newbornsReading(node, output, mesh, (birth) => birth())[0] ?? new Vector3();
}

/** The point the seed draws on the triangle, as a shape, in its own space. */
function shapePoint(): Vector3 {
  return newbornReading("random-mesh-point", "position", rock());
}

/** The weights of the corners at `point`, on the triangle's plane. */
function weightsAt(point: Vector3): [number, number, number] {
  return [1 - point.x - point.y, point.x, point.y];
}

/** Where three draws corner `corner` of `mesh` in its pose: in the world. */
function drawn(mesh: SkinnedMesh, corner: number, vector = CORNERS[corner]): Vector3 {
  return mesh.applyBoneTransform(corner, vector.clone()).applyMatrix4(mesh.matrixWorld);
}

describe("random-scene-mesh-point", () => {
  it("puts the point and the normal where three draws the mesh", () => {
    const mesh = rock();
    const position = newbornReading("random-scene-mesh-point", "position", mesh);
    expect(position.distanceTo(shapePoint().applyMatrix4(mesh.matrixWorld))).toBeLessThan(1e-5);
    const normal = newbornReading("random-scene-mesh-point", "normal", mesh);
    const expected = new Vector3(0, 0, 1)
      .applyMatrix3(new Matrix3().getNormalMatrix(mesh.matrixWorld))
      .normalize();
    expect(normal.distanceTo(expected)).toBeLessThan(1e-5);
  });

  it("moves with the mesh between its previous place and this one", () => {
    const mesh = rock();
    const [still, moving] = newbornsReading(
      "random-scene-mesh-point",
      "velocity",
      mesh,
      (birth) => {
        FXWorld.update(0.02);
        birth();
        mesh.position.x += 0.1;
        mesh.updateMatrixWorld(true);
        FXWorld.update(0.02);
        birth();
      },
    );
    expect(still.length()).toBe(0);
    expect(moving.distanceTo(new Vector3(5, 0, 0))).toBeLessThan(1e-3);
  });
});

describe("random-skinned-mesh-point", () => {
  it("puts the unposed point where three draws the mesh at rest, then skins it as three draws it", () => {
    for (const boundBeforeWorld of [false, true]) {
      const mesh = arm(boundBeforeWorld);
      const [unposed, posed] = newbornsReading(
        "random-skinned-mesh-point",
        "position",
        mesh,
        (birth) => {
          birth();
          pose(mesh);
          birth();
        },
      );
      const raw = shapePoint();
      expect(unposed.distanceTo(raw.clone().applyMatrix4(mesh.bindMatrix))).toBeLessThan(1e-5);
      const expected = new Vector3();
      weightsAt(raw).forEach((weight, corner) => {
        expected.addScaledVector(drawn(mesh, corner), weight);
      });
      expect(posed.distanceTo(expected)).toBeLessThan(1e-5);
    }
  });

  it("turns the normal with the skin", () => {
    const mesh = arm();
    const [unposed, posed] = newbornsReading(
      "random-skinned-mesh-point",
      "normal",
      mesh,
      (birth) => {
        birth();
        pose(mesh);
        birth();
      },
    );
    expect(unposed.distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-5);
    const expected = new Vector3();
    weightsAt(shapePoint()).forEach((weight, corner) => {
      const base = CORNERS[corner];
      const tip = drawn(mesh, corner, base.clone().add(new Vector3(0, 0, 1)));
      expected.addScaledVector(tip.sub(drawn(mesh, corner)), weight);
    });
    expect(posed.distanceTo(expected.normalize())).toBeLessThan(1e-5);
  });

  it("moves at the surface's velocity between the previous pose and this one", () => {
    const mesh = arm();
    const [still, moving] = newbornsReading(
      "random-skinned-mesh-point",
      "velocity",
      mesh,
      (birth) => {
        mesh.skeleton.update();
        FXWorld.update(0.02);
        birth();
        pose(mesh);
        FXWorld.update(0.02);
        birth();
      },
    );
    expect(still.length()).toBe(0);
    const expected = new Vector3();
    weightsAt(shapePoint()).forEach((weight, corner) => {
      const from = CORNERS[corner].clone().applyMatrix4(mesh.matrixWorld);
      expected.addScaledVector(drawn(mesh, corner).sub(from), weight / 0.02);
    });
    expect(moving.distanceTo(expected)).toBeLessThan(1e-3);
    expect(expected.length()).toBeGreaterThan(1);
  });

  it("counts the whole mesh's move in the velocity", () => {
    const mesh = arm();
    const [, moving] = newbornsReading("random-skinned-mesh-point", "velocity", mesh, (birth) => {
      mesh.skeleton.update();
      FXWorld.update(0.02);
      birth();
      mesh.position.z += 0.1;
      mesh.updateMatrixWorld(true);
      mesh.skeleton.update();
      FXWorld.update(0.02);
      birth();
    });
    expect(moving.distanceTo(new Vector3(0, 0, 5))).toBeLessThan(1e-3);
  });
});

describe("scene mesh point artifacts", () => {
  /** The fused GPU program and the JS artifact of a graph placing particles at `output`. */
  function artifactsPlacingAt(node: FXNode, output: FXOutput) {
    const graph = graphPlacingAt(node, output);
    const bundle = compileBehaviorBundle(graph, particleBehaviorTargetsFor(graph, true));
    const program = bundle.standardProgram;
    if (program === undefined) {
      throw new Error("no GPU program");
    }
    return { program, behavior: assembleBehaviorArtifact(bundle.kernel) };
  }

  it("declares a skinned mesh's table, entries and bones in both artifacts", () => {
    const { program, behavior } = artifactsPlacingAt("random-skinned-mesh-point", "position");
    const [uniform] = Object.keys(program.skinnedSurfaces ?? {});
    expect(program.skinnedSurfaces).toEqual({ [uniform]: "arm" });
    const source = fusedVertexSource(program);
    expect(source).toContain(`uniform sampler2D ${uniform};`);
    expect(source).toContain(`uniform sampler2D ${uniform}_bones;`);
    expect(source).toContain(`uniform vec4 ${uniform}_object[${String(FX_OBJECT_ENTRIES)}];`);
    expect(assembleGpuKernelArtifact(program).skinnedSurfaces).toEqual({ [uniform]: "arm" });

    const [binding] = Object.keys(behavior.skinnedSurfaces ?? {});
    expect(behavior.skinnedSurfaces).toEqual({ [binding]: "arm" });
    expect(behavior.meshSurfaces).toBeUndefined();
    expect(Object.keys(behavior.bindings)).not.toContain(binding);
  });

  it("declares a mesh's table and entries, and no bones", () => {
    const { program, behavior } = artifactsPlacingAt("random-scene-mesh-point", "position");
    const [uniform] = Object.keys(program.objectSurfaces ?? {});
    expect(program.objectSurfaces).toEqual({ [uniform]: "arm" });
    const source = fusedVertexSource(program);
    expect(source).toContain(`uniform vec4 ${uniform}_object[${String(FX_OBJECT_ENTRIES)}];`);
    expect(source).not.toContain("_bones");
    expect(Object.keys(behavior.objectSurfaces ?? {})).toHaveLength(1);
  });

  it("reads the previous pose, and has it kept, only where the velocity is used", () => {
    for (const node of ["random-scene-mesh-point", "random-skinned-mesh-point"] as const) {
      const still = artifactsPlacingAt(node, "position");
      expect(fusedVertexSource(still.program)).not.toContain("_previousBones");
      expect(still.program.movingSurfaces).toBeUndefined();
      expect(still.behavior.movingSurfaces).toBeUndefined();

      const moving = artifactsPlacingAt(node, "velocity");
      expect(assembleGpuKernelArtifact(moving.program).movingSurfaces).toHaveLength(1);
      expect(moving.behavior.movingSurfaces).toHaveLength(1);
    }
    const skinned = artifactsPlacingAt("random-skinned-mesh-point", "velocity");
    const [uniform] = Object.keys(skinned.program.skinnedSurfaces ?? {});
    expect(fusedVertexSource(skinned.program)).toContain(
      `uniform sampler2D ${uniform}_previousBones;`,
    );
  });

  it("computes neither the normal nor the previous pose for the position alone", () => {
    const { program, behavior } = artifactsPlacingAt("random-skinned-mesh-point", "position");
    expect(fusedVertexSource(program)).not.toContain("normalize");
    const spawn = String(behavior.spawn);
    expect(spawn).toContain("_bones");
    expect(spawn).not.toContain("Math.sqrt");
    expect(spawn).not.toContain("previousBones");
  });
});
