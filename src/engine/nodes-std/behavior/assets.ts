import {
  FX_SURFACE_HEADER_TEXELS,
  FX_SURFACE_NORMAL_A,
  FX_SURFACE_NORMAL_B,
  FX_SURFACE_NORMAL_C,
  FX_SURFACE_TEXELS_PER_TRIANGLE,
  FX_SURFACE_VERTEX_A,
  FX_SURFACE_VERTEX_B,
  FX_SURFACE_VERTEX_C,
} from "sparcoon";

import type { FXExpr } from "../../core/ir/FXExpr";
import { FX_NO_SURFACE_DISTANCE } from "../../core/ir/FXFunctions.Internal";
import type { FXNodeDefinition } from "../../core/nodes/defineNode";
import { defineNode } from "../../core/nodes/defineNode";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import { rand, unitOrZero } from "./common";

/**
 * Standard-library behavior nodes sampling a content-library asset, which the app supplies by its
 * name - a mesh's surface, a volume's 3D texture.
 */

const VEC3 = FX_VALUE_TYPES.vec3;

/** With a mesh picked - 8 texel fetches at 8 (the texture node's figure for one), 4 draws (~2
 *  each), the column, alias coin and fold (~12), and two 3-corner vec3 blends with a normalize
 *  (~30). */
const RANDOM_MESH_POINT_COST = 114;

/**
 * A random point uniform by area on the surface of a mesh asset, with the mesh's normal there
 * (interpolated across the triangle, normalized), both in the mesh's own space, drawn anew each
 * time it runs (once per particle in the spawn, every step in the update). The mesh is read into a
 * surface table by the runtime when the emitter is built (sparcoon's `surfaceTableLayout.ts`).
 *
 * A triangle is drawn from the table's alias columns (a uniform column, then a coin against its
 * probability), and the point inside it from two draws folded back into the triangle. With no mesh
 * picked every particle sits at the origin.
 */
export const fxRandomMeshPoint = defineNode({
  type: "random-mesh-point",
  domain: "behavior",
  phase: "spawn",
  phaseFlexible: true,
  category: "spawn",
  inputs: {},
  outputs: { position: { type: "vec3" }, normal: { type: "vec3" } },
  params: {},
  assets: { mesh: "mesh" },
  cost: ({ params }) => (params["mesh"] === "" ? 0 : RANDOM_MESH_POINT_COST),
  build: ({ assets, local, fn }) => {
    const table = assets["mesh"];
    if (table === undefined) {
      return { position: fn.litVec(0, 0, 0), normal: fn.litVec(0, 1, 0) };
    }
    const texel = (index: FXExpr): FXExpr => fn.call("meshFetch", table, index);
    // The first texel of triangle `triangle`, plus `offset`.
    const texelOf = (triangle: FXExpr, offset: number): FXExpr =>
      fn.add(
        fn.mul(triangle, fn.lit(FX_SURFACE_TEXELS_PER_TRIANGLE)),
        fn.lit(FX_SURFACE_HEADER_TEXELS + offset),
      );

    const count = local("mp_count", fn.swizzle(texel(fn.lit(0)), "x"));
    const column = local(
      "mp_column",
      fn.call("min", fn.call("floor", fn.mul(rand(fn), count)), fn.sub(count, fn.lit(1))),
    );
    const probability = fn.swizzle(texel(texelOf(column, FX_SURFACE_VERTEX_A)), "w");
    const alias = fn.swizzle(texel(texelOf(column, FX_SURFACE_VERTEX_B)), "w");
    // 1 keeps the column's own triangle, 0 takes its alias.
    const keep = fn.call("step", rand(fn), probability);
    const triangle = local("mp_triangle", fn.call("mix", alias, column, keep));

    // Two draws in the unit square, the half past the diagonal folded back onto the triangle.
    const first = local("mp_u", rand(fn));
    const second = local("mp_v", rand(fn));
    const fold = local("mp_fold", fn.call("step", fn.lit(1), fn.add(first, second)));
    const unfold = (value: FXExpr): FXExpr =>
      fn.add(value, fn.mul(fold, fn.sub(fn.lit(1), fn.mul(fn.lit(2), value))));
    const weightB = local("mp_wb", unfold(first));
    const weightC = local("mp_wc", unfold(second));
    const weightA = local("mp_wa", fn.sub(fn.sub(fn.lit(1), weightB), weightC));

    const corner = (offset: number): FXExpr => fn.swizzle(texel(texelOf(triangle, offset)), "xyz");
    const blend = (a: number, b: number, c: number): FXExpr =>
      fn.add(
        fn.add(fn.mul(corner(a), weightA), fn.mul(corner(b), weightB)),
        fn.mul(corner(c), weightC),
      );
    return {
      position: blend(FX_SURFACE_VERTEX_A, FX_SURFACE_VERTEX_B, FX_SURFACE_VERTEX_C),
      normal: fn.call(
        "normalize",
        blend(FX_SURFACE_NORMAL_A, FX_SURFACE_NORMAL_B, FX_SURFACE_NORMAL_C),
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
  fxSdfSample,
  fxSceneDepthSample,
];
