import {
  FX_BONE_TEXELS,
  FX_OBJECT_FRAME,
  FX_OBJECT_NORMAL_FRAME,
  FX_OBJECT_PREVIOUS_FRAME,
  FX_OBJECT_STATE,
  FX_SKINNED_SURFACE_TEXELS_PER_TRIANGLE,
  FX_SURFACE_HEADER_TEXELS,
  FX_SURFACE_NORMAL_A,
  FX_SURFACE_SKIN_INDEX_A,
  FX_SURFACE_SKIN_WEIGHT_A,
  FX_SURFACE_TEXELS_PER_TRIANGLE,
  FX_SURFACE_VERTEX_A,
  FX_SURFACE_VERTEX_B,
} from "sparcoon";
import { FX_NO_SURFACE_DISTANCE } from "sparcoon/helpers";

import type { FXExpr } from "../../core/ir/FXExpr";
import {
  FX_SEED_HASH_CALL_COST,
  seedHashFunctionName,
} from "../../core/ir/noise/FXSeedHash.Internal";
import type { FXExprBuilderApi, FXNodeDefinition } from "../../core/nodes/defineNode";
import { defineNode } from "../../core/nodes/defineNode";
import { FX_RANDOM_SEED_INPUT } from "../../core/socket/FXReadableBuiltins";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import { unitOrZero } from "./common";

/**
 * Standard-library behavior nodes sampling a content-library asset, which the app supplies by its
 * name - a mesh's surface as a shape, the surface of a mesh or skinned mesh of the scene, a
 * volume's 3D texture.
 */

const VEC3 = FX_VALUE_TYPES.vec3;
const VEC4 = FX_VALUE_TYPES.vec4;
const MAT3 = FX_VALUE_TYPES.mat3;
const MAT4 = FX_VALUE_TYPES.mat4;

/** With a mesh picked - 8 texel fetches at 8 (the texture node's figure for one), one 4-wide seed
 *  hash, the column, alias coin and fold (~12), and two 3-corner vec3 blends with a normalize
 *  (~30). */
const RANDOM_MESH_POINT_COST = 106 + FX_SEED_HASH_CALL_COST[4];

/** The object entries every point of a scene's mesh reads - its frame (4), the normal matrix
 *  (3) and the state (1) - and those its velocity reads - the previous frame (4) and the state. */
const OBJECT_ENTRIES_COST = 9;

/** With a mesh of the scene picked - Random Mesh Point's, the entries, the point and the normal
 *  through the frame and its normal matrix (~25), and for the velocity the point through the
 *  previous frame and the difference (~22). An unwired velocity compiles away, but the estimate
 *  counts it. */
const RANDOM_SCENE_MESH_POINT_COST = RANDOM_MESH_POINT_COST + OBJECT_ENTRIES_COST + 25 + 22;

/** With a skinned mesh picked - Random Mesh Point's, the entries, plus at each corner 2 texel
 *  fetches for its bones and 16 for their matrices at 8, the weighted matrix (~32) and the position
 *  and normal through two matrices each (~32); for the velocity, the previous pose's 16 matrices at
 *  8, their weighted matrix (~32) and the position through two matrices (~16); and the unposed
 *  point and normal (~25), the pose blend and the velocity's blend (~30). An unwired velocity
 *  compiles away, but the estimate counts it. */
const RANDOM_SKINNED_MESH_POINT_COST =
  RANDOM_MESH_POINT_COST +
  OBJECT_ENTRIES_COST +
  3 * (18 * 8 + 32 + 32) +
  3 * (16 * 8 + 32 + 16) +
  25 +
  30;

/** The node inputs every random-mesh-point node takes. */
const SURFACE_POINT_INPUTS = {
  seed: { type: "vec3", default: { targetInput: FX_RANDOM_SEED_INPUT } },
  salt: { type: "float", value: 0, step: 1 },
} as const;

/** One value per corner of a triangle. */
type FXCorners = readonly [FXExpr, FXExpr, FXExpr];

type FXCorner = 0 | 1 | 2;

function eachCorner(value: (corner: FXCorner) => FXExpr): FXCorners {
  return [value(0), value(1), value(2)];
}

/** A point every random-mesh-point node draws: a triangle of the table, and the weights of its
 *  corners. */
interface FXSurfacePoint {
  /** Texel `offset` of the triangle. */
  readonly texel: (offset: number) => FXExpr;
  /** `values` (one per corner) blended by the point's weights. */
  readonly blend: (values: FXCorners) => FXExpr;
}

/**
 * The point of the surface table `table`, `stride` texels per triangle, that `seed` and `salt`
 * draw: a triangle from the table's alias columns (a uniform column, then a coin against its
 * probability), and the point inside it from two draws folded back into the triangle - the four
 * draws are the components of one hash of the seed.
 */
function surfacePoint(
  table: FXExpr,
  stride: number,
  inputs: { readonly seed: FXExpr; readonly salt: FXExpr },
  local: (hint: string, expr: FXExpr) => FXExpr,
  fn: FXExprBuilderApi,
): FXSurfacePoint {
  // A float id reaches here as is: the target-input default skips the socket's coercion.
  const seed = fn.coerceNumeric(inputs.seed, FX_VALUE_TYPES.vec3);
  const draws = local("mp_draws", fn.call(seedHashFunctionName(4), seed, inputs.salt));
  const fetch = (index: FXExpr): FXExpr => fn.call("meshFetch", table, index);
  const texelOf = (triangle: FXExpr, offset: number): FXExpr =>
    fn.add(fn.mul(triangle, fn.lit(stride)), fn.lit(FX_SURFACE_HEADER_TEXELS + offset));

  const count = local("mp_count", fn.swizzle(fetch(fn.lit(0)), "x"));
  const column = local(
    "mp_column",
    fn.call(
      "min",
      fn.call("floor", fn.mul(fn.swizzle(draws, "x"), count)),
      fn.sub(count, fn.lit(1)),
    ),
  );
  const probability = fn.swizzle(fetch(texelOf(column, FX_SURFACE_VERTEX_A)), "w");
  const alias = fn.swizzle(fetch(texelOf(column, FX_SURFACE_VERTEX_B)), "w");
  // 1 keeps the column's own triangle, 0 takes its alias.
  const keep = fn.call("step", fn.swizzle(draws, "y"), probability);
  const triangle = local("mp_triangle", fn.call("mix", alias, column, keep));

  // Two draws in the unit square, the half past the diagonal folded back onto the triangle.
  const first = local("mp_u", fn.swizzle(draws, "z"));
  const second = local("mp_v", fn.swizzle(draws, "w"));
  const fold = local("mp_fold", fn.call("step", fn.lit(1), fn.add(first, second)));
  const unfold = (value: FXExpr): FXExpr =>
    fn.add(value, fn.mul(fold, fn.sub(fn.lit(1), fn.mul(fn.lit(2), value))));
  const weightB = local("mp_wb", unfold(first));
  const weightC = local("mp_wc", unfold(second));
  const weightA = local("mp_wa", fn.sub(fn.sub(fn.lit(1), weightB), weightC));

  return {
    texel: (offset) => fetch(texelOf(triangle, offset)),
    blend: ([a, b, c]) =>
      fn.add(fn.add(fn.mul(a, weightA), fn.mul(b, weightB)), fn.mul(c, weightC)),
  };
}

/** The three corners' `xyz` of the triangle's texels from `offset`. */
function corners(point: FXSurfacePoint, offset: number, fn: FXExprBuilderApi): FXCorners {
  return eachCorner((corner) => fn.swizzle(point.texel(offset + corner), "xyz"));
}

/**
 * A random point uniform by area on the surface of a mesh asset, with the mesh's normal there
 * (interpolated across the triangle, normalized), both in the mesh's own space. The point is a
 * function of `seed` and `salt`, as the Hash node's value is: the same pair gives the same point in
 * either phase, in any emitter, on either backend. The seed defaults to the particle's, so a
 * particle keeps one point in the update too; a seed that changes with time draws a new one. The
 * mesh is read into a surface table by the runtime when the emitter is built (sparcoon's
 * `surfaceTableLayout.ts`). With no mesh picked every particle sits at the origin.
 */
export const fxRandomMeshPoint = defineNode({
  type: "random-mesh-point",
  domain: "behavior",
  phase: "spawn",
  phaseFlexible: true,
  category: "spawn",
  inputs: SURFACE_POINT_INPUTS,
  outputs: { position: { type: "vec3" }, normal: { type: "vec3" } },
  params: {},
  assets: { mesh: "mesh" },
  cost: ({ params }) => (params["mesh"] === "" ? 0 : RANDOM_MESH_POINT_COST),
  build: ({ inputs, assets, local, fn }) => {
    const table = assets["mesh"];
    if (table === undefined) {
      return { position: fn.litVec(0, 0, 0), normal: fn.litVec(0, 1, 0) };
    }
    const point = surfacePoint(table, FX_SURFACE_TEXELS_PER_TRIANGLE, inputs, local, fn);
    return {
      position: point.blend(corners(point, FX_SURFACE_VERTEX_A, fn)),
      normal: fn.call("normalize", point.blend(corners(point, FX_SURFACE_NORMAL_A, fn))),
    };
  },
});

/** The pose of a mesh of the scene, as its object entries give it (sparcoon's
 *  `surfaceTableLayout.ts`). */
interface FXObjectFrames {
  /** The frame now and at the previous pose: a mesh's world matrix, a skinned mesh's bind matrix. */
  readonly frame: FXExpr;
  readonly previousFrame: FXExpr;
  /** The normal matrix of the frame. */
  readonly normalFrame: FXExpr;
  /** 1 once the object holds a pose, else 0. */
  readonly posed: FXExpr;
  /** 1 over the time from the previous pose to this one, 0 while the object holds still. */
  readonly motion: FXExpr;
}

/** The object entries of the surface `table`. The entries only the velocity reads are read through
 *  `previousObjectEntry`, which tells the runtime to keep the previous pose. */
function objectFrames(
  table: FXExpr,
  local: (hint: string, expr: FXExpr) => FXExpr,
  fn: FXExprBuilderApi,
): FXObjectFrames {
  const entry = (reader: string, index: number): FXExpr => fn.call(reader, table, fn.lit(index));
  const matrix = (hint: string, reader: string, first: number): FXExpr =>
    local(hint, fn.construct(MAT4, ...[0, 1, 2, 3].map((column) => entry(reader, first + column))));
  const normalColumn = (column: number): FXExpr =>
    fn.swizzle(entry("objectEntry", FX_OBJECT_NORMAL_FRAME + column), "xyz");
  return {
    frame: matrix("ob_frame", "objectEntry", FX_OBJECT_FRAME),
    previousFrame: matrix("ob_previousFrame", "previousObjectEntry", FX_OBJECT_PREVIOUS_FRAME),
    normalFrame: local(
      "ob_normalFrame",
      fn.construct(MAT3, normalColumn(0), normalColumn(1), normalColumn(2)),
    ),
    posed: fn.swizzle(entry("objectEntry", FX_OBJECT_STATE), "x"),
    motion: fn.swizzle(entry("previousObjectEntry", FX_OBJECT_STATE), "y"),
  };
}

/** `vector` (`w` 1 for a point, 0 for a direction) through the mat4 `matrix`. */
function through(matrix: FXExpr, vector: FXExpr, w: number, fn: FXExprBuilderApi): FXExpr {
  return fn.swizzle(fn.mul(matrix, fn.construct(VEC4, vector, fn.lit(w))), "xyz");
}

/** The outputs of a mesh of the scene with none picked: every particle at the origin, still. */
function noObjectPoint(fn: FXExprBuilderApi): Record<string, FXExpr> {
  return {
    position: fn.litVec(0, 0, 0),
    normal: fn.litVec(0, 1, 0),
    velocity: fn.litVec(0, 0, 0),
  };
}

/** The outputs every node sampling a mesh of the scene gives. */
const OBJECT_POINT_OUTPUTS = {
  position: { type: "vec3" },
  normal: { type: "vec3" },
  velocity: { type: "vec3" },
} as const;

/**
 * Random Mesh Point on a mesh of the scene, in the world: the point and the normal taken through
 * the mesh's world matrix (the normal through its normal matrix), as three draws the mesh. Its
 * velocity is how far the point moved from the previous pose of the mesh to this one, over the
 * time between them: zero while the mesh holds still or has one pose yet.
 */
export const fxRandomSceneMeshPoint = defineNode({
  type: "random-scene-mesh-point",
  domain: "behavior",
  phase: "spawn",
  phaseFlexible: true,
  category: "spawn",
  inputs: SURFACE_POINT_INPUTS,
  outputs: OBJECT_POINT_OUTPUTS,
  params: {},
  assets: { mesh: "sceneMesh" },
  cost: ({ params }) => (params["mesh"] === "" ? 0 : RANDOM_SCENE_MESH_POINT_COST),
  build: ({ inputs, assets, local, fn }) => {
    const table = assets["mesh"];
    if (table === undefined) {
      return noObjectPoint(fn);
    }
    const point = surfacePoint(table, FX_SURFACE_TEXELS_PER_TRIANGLE, inputs, local, fn);
    const object = objectFrames(table, local, fn);
    const shape = local("ob_point", point.blend(corners(point, FX_SURFACE_VERTEX_A, fn)));
    const position = through(object.frame, shape, 1, fn);
    return {
      position,
      normal: fn.call(
        "normalize",
        fn.mul(object.normalFrame, point.blend(corners(point, FX_SURFACE_NORMAL_A, fn))),
      ),
      velocity: fn.mul(
        fn.sub(position, through(object.previousFrame, shape, 1, fn)),
        object.motion,
      ),
    };
  },
});

/**
 * Random Mesh Point on a skinned mesh of the scene, in its pose, in the world: each corner of the
 * triangle skinned as three skins a vertex (its four bones' matrices weighted, after the mesh's
 * bind matrix), position and normal alike, without the inverse bind matrix three's shader cancels
 * the model matrix with in its default `attached` bind mode. Where the mesh has no pose yet, the unposed point and normal are taken
 * through the bind matrix. Its velocity is how far the point moved from the previous pose to this
 * one, over the time between them, the mesh's own move included: zero while the mesh holds still
 * or has one pose yet.
 */
export const fxRandomSkinnedMeshPoint = defineNode({
  type: "random-skinned-mesh-point",
  domain: "behavior",
  phase: "spawn",
  phaseFlexible: true,
  category: "spawn",
  inputs: SURFACE_POINT_INPUTS,
  outputs: OBJECT_POINT_OUTPUTS,
  params: {},
  assets: { mesh: "skinnedMesh" },
  cost: ({ params }) => (params["mesh"] === "" ? 0 : RANDOM_SKINNED_MESH_POINT_COST),
  build: ({ inputs, assets, local, fn }) => {
    const table = assets["mesh"];
    if (table === undefined) {
      return noObjectPoint(fn);
    }
    const point = surfacePoint(table, FX_SKINNED_SURFACE_TEXELS_PER_TRIANGLE, inputs, local, fn);
    const object = objectFrames(table, local, fn);
    const positions = corners(point, FX_SURFACE_VERTEX_A, fn);
    const normals = corners(point, FX_SURFACE_NORMAL_A, fn);
    const skinCorner = (
      corner: FXCorner,
    ): { position: FXExpr; normal: FXExpr; previousPosition: FXExpr } => {
      const bones = local(
        `sk_bones${String(corner)}`,
        point.texel(FX_SURFACE_SKIN_INDEX_A + corner),
      );
      const weights = local(
        `sk_weights${String(corner)}`,
        point.texel(FX_SURFACE_SKIN_WEIGHT_A + corner),
      );
      /** The corner's bones' matrices of a pose, read by `fetch`, weighted. */
      const skinMatrix = (hint: string, fetch: "boneFetch" | "previousBoneFetch"): FXExpr =>
        local(
          `${hint}${String(corner)}`,
          fn.construct(
            MAT4,
            ...[0, 1, 2, 3].map((column) =>
              (["x", "y", "z", "w"] as const)
                .map((slot) =>
                  fn.mul(
                    fn.call(
                      fetch,
                      table,
                      fn.add(
                        fn.mul(fn.swizzle(bones, slot), fn.lit(FX_BONE_TEXELS)),
                        fn.lit(column),
                      ),
                    ),
                    fn.swizzle(weights, slot),
                  ),
                )
                .reduce((sum, term) => fn.add(sum, term)),
            ),
          ),
        );
      /** `vector` (`w` 1 for a point, 0 for a direction) through the bind matrix `frame`, then
       *  the bones `skin`. */
      const pose = (vector: FXExpr, w: number, skin: FXExpr, frame: FXExpr): FXExpr =>
        through(skin, through(frame, vector, w, fn), w, fn);
      const skin = skinMatrix("sk_skin", "boneFetch");
      return {
        position: pose(positions[corner], 1, skin, object.frame),
        normal: pose(normals[corner], 0, skin, object.frame),
        previousPosition: pose(
          positions[corner],
          1,
          skinMatrix("sk_skinPrevious", "previousBoneFetch"),
          object.previousFrame,
        ),
      };
    };
    const skinned = [skinCorner(0), skinCorner(1), skinCorner(2)] as const;
    const blendPosed = (unposed: FXExpr, field: "position" | "normal"): FXExpr =>
      fn.call(
        "mix",
        unposed,
        point.blend(eachCorner((corner) => skinned[corner][field])),
        object.posed,
      );
    return {
      position: blendPosed(through(object.frame, point.blend(positions), 1, fn), "position"),
      normal: fn.call(
        "normalize",
        blendPosed(fn.mul(object.normalFrame, point.blend(normals)), "normal"),
      ),
      velocity: fn.mul(
        point.blend(
          eachCorner((corner) =>
            fn.sub(skinned[corner].position, skinned[corner].previousPosition),
          ),
        ),
        object.motion,
      ),
    };
  },
});

/** The tetrahedron the SDF is sampled on around a point - each corner is a texel off on every axis.
 *  The four corners' outer products sum to 4 times the identity, which the gradient divides out. */
const TETRAHEDRON = [
  [1, -1, -1],
  [-1, -1, 1],
  [-1, 1, -1],
  [1, 1, 1],
] as const;

/** With a volume picked - 4 texture fetches at 8, the box mapping, clamp and texel offsets (~33),
 *  the value and gradient (~27), the normalize (~15) and the distance outside the box (~13). */
const SDF_SAMPLE_COST = 120;

/**
 * The signed distance from `position` to the surface a volume asset (an SDF, an R8 3D texture)
 * holds, and the outward normal there. The volume fills the box from `boxMin` to `boxMax`, in the
 * space `position` is in, and a texel's value `v` (its byte over 255) is the distance
 * `v * scale + bias`. Picking a volume sets the four from its bake. Outside the box the distance
 * grows by the distance to the box, and the normal is the one at its nearest point.
 *
 * The distance and normal come from four fetches on a tetrahedron one texel across - the mean of
 * the four, and their gradient. With no volume picked the surface is infinitely far.
 */
export const fxSdfSample = defineNode({
  type: "sdf-sample",
  domain: "behavior",
  phase: "update",
  phaseFlexible: true,
  category: "force",
  inputs: {
    position: { type: "vec3", default: { targetInput: "PARTICLE_POSITION" } },
    boxMin: { type: "vec3", value: [-1, -1, -1] },
    boxMax: { type: "vec3", value: [1, 1, 1] },
    scale: { type: "float", value: 1, step: 0.01 },
    bias: { type: "float", value: 0, step: 0.01 },
  },
  outputs: { distance: { type: "float" }, normal: { type: "vec3" } },
  params: {},
  assets: { volume: "volume" },
  cost: ({ params }) => (params["volume"] === "" ? 0 : SDF_SAMPLE_COST),
  build: ({ inputs, assets, local, fn }) => {
    const volume = assets["volume"];
    if (volume === undefined) {
      return { distance: fn.lit(FX_NO_SURFACE_DISTANCE), normal: fn.litVec(0, 1, 0) };
    }
    const position = inputs["position"];
    const boxMin = inputs["boxMin"];
    const extent = local("sd_extent", fn.sub(inputs["boxMax"], boxMin));
    const nearest = local("sd_near", fn.call("clamp", position, boxMin, inputs["boxMax"]));
    const uvw = local("sd_uvw", fn.div(fn.sub(nearest, boxMin), extent));
    const texel = local("sd_texel", fn.div(fn.litVec(1, 1, 1), fn.call("volumeSize", volume)));
    const samples = TETRAHEDRON.map((corner, i) =>
      local(
        `sd_f${String(i)}`,
        fn.call("volumeFetch", volume, fn.add(uvw, fn.mul(texel, fn.litVec(...corner)))),
      ),
    );
    // The samples summed with signs `signs` (each 1 or -1).
    const sum = (signs: readonly number[]): FXExpr =>
      samples.reduce<FXExpr | undefined>((total, sample, i) => {
        const positive = signs[i] === 1;
        if (total === undefined) {
          return positive ? sample : fn.neg(sample);
        }
        return positive ? fn.add(total, sample) : fn.sub(total, sample);
      }, undefined) as FXExpr;
    const value = fn.mul(sum([1, 1, 1, 1]), fn.lit(0.25));
    // d(value)/d(uvw), per axis over the texel the tetrahedron spans on it.
    const gradient = fn.div(
      fn.construct(
        VEC3,
        ...[0, 1, 2].map((axis) => sum(TETRAHEDRON.map((corner) => corner[axis] as number))),
      ),
      fn.mul(texel, fn.lit(4)),
    );
    const scale = inputs["scale"];
    // The distance's gradient in the box's space - through `scale`, and the box's extent per axis.
    const normal = unitOrZero(fn.div(fn.mul(gradient, scale), extent), "sd_n", local, fn);
    const outside = fn.call("length", fn.sub(position, nearest));
    return {
      distance: fn.add(fn.add(fn.mul(value, scale), inputs["bias"]), outside),
      normal,
    };
  },
});

/** Five depth fetches, the projection and five unprojections (~120), the normal's differences,
 *  cross and normalize (~45), and the checks and the distance (~20). */
const SCENE_DEPTH_SAMPLE_COST = 185;

/**
 * The signed distance from `position` to the opaque scene the emitter's camera sees, and the
 * normal there, both in world space - read from the camera's depth (see `fxSetCameraDepth`), the
 * frame before. The surface is the one in front of or around the point along the view: a point
 * more than `thickness` behind it is behind an occluder, and finds none, as does a point off screen
 * or behind the camera. The depth reaches only the GPU simulation - simulated on the CPU, it finds
 * no surface.
 */
export const fxSceneDepthSample = defineNode({
  type: "scene-depth-sample",
  domain: "behavior",
  phase: "update",
  phaseFlexible: true,
  category: "force",
  inputs: {
    position: { type: "vec3", default: { targetInput: "PARTICLE_POSITION" } },
    thickness: { type: "float", value: 0.5, min: 0, step: 0.05 },
  },
  outputs: { distance: { type: "float" }, normal: { type: "vec3" } },
  params: {},
  readsSceneDepth: true,
  cost: SCENE_DEPTH_SAMPLE_COST,
  build: ({ inputs, local, fn }) => {
    const contact = local(
      "dc",
      fn.call("sceneDepthContact", inputs["position"], inputs["thickness"]),
    );
    return { distance: fn.swizzle(contact, "w"), normal: fn.swizzle(contact, "xyz") };
  },
});

export const FX_BEHAVIOR_ASSET_NODES: readonly FXNodeDefinition[] = [
  fxRandomMeshPoint,
  fxRandomSceneMeshPoint,
  fxRandomSkinnedMeshPoint,
  fxSdfSample,
  fxSceneDepthSample,
];
