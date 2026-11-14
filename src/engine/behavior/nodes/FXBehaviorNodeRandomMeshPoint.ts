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
import { litVec } from "../../core/ir/FXExprBuilder";
import type { FXNodeMeta } from "../../core/nodes/FXSocketSpec";
import type { FXSocketDescriptor } from "../../core/socket/FXSocket";
import { FX_VALUE_TYPES } from "../../core/socket/FXValueType";
import { RANDOM_MESH_POINT_COST, RANDOM_MESH_POINT_META } from "../../nodes-std/manualNodeMetas";
import { FXBehaviorNode } from "../FXBehaviorNode";
import { FXBehaviorPhase } from "../FXBehaviorPhase";
import type { FXKernelContext } from "../FXKernelContext";

const VEC3 = FX_VALUE_TYPES.vec3;

/** An unset mesh is a valid, quiescent state (every particle at the origin), not an error. */
function resolveMeshName(mesh: unknown): string {
  return typeof mesh === "string" ? mesh : "";
}

/**
 * Behavior node (spawn or update): a random point uniform by area on the surface of a mesh asset,
 * with the mesh's normal there (interpolated across the triangle, normalized), both in the mesh's
 * own space, drawn anew each time it runs (once per particle in the spawn, every step in the
 * update). The mesh is the app's geometry of that name, read into a surface table by the runtime
 * when the emitter is built (sparcoon's `surfaceTableLayout.ts`); the node only declares it.
 *
 * A triangle is drawn from the table's alias columns (a uniform column, then a coin against its
 * probability), and the point inside it from two draws folded back into the triangle.
 */
export class FXBehaviorNodeRandomMeshPoint extends FXBehaviorNode {
  public readonly type = "random-mesh-point";
  public readonly phase = FXBehaviorPhase.SPAWN;
  public override readonly phaseFlexible = true;
  public readonly inputs: readonly FXSocketDescriptor[] = [];
  public readonly outputs: readonly FXSocketDescriptor[] = [
    { key: "position", type: VEC3 },
    { key: "normal", type: VEC3 },
  ];

  private mesh: string;

  constructor(mesh: unknown) {
    super();
    this.mesh = resolveMeshName(mesh);
  }

  public override get targetReads(): readonly string[] {
    return [];
  }

  public override get meshSurface(): string | undefined {
    return this.mesh === "" ? undefined : this.mesh;
  }

  public static describe(): FXNodeMeta {
    return RANDOM_MESH_POINT_META;
  }

  /** 0 with no mesh picked (a bare literal, see {@link build}). */
  public override estimateCost(): number {
    return this.mesh === "" ? 0 : RANDOM_MESH_POINT_COST;
  }

  public override applyParams(params: Readonly<Record<string, unknown>>): void {
    this.mesh = resolveMeshName(params["mesh"]);
  }

  public override cacheKey(): string {
    return this.mesh;
  }

  public build(ctx: FXKernelContext): void {
    if (this.mesh === "") {
      ctx.setOutput("position", litVec(0, 0, 0));
      ctx.setOutput("normal", litVec(0, 1, 0));
      return;
    }
    const fn = ctx.builders;
    const table = ctx.allocateSurface(this.mesh);
    const local = (hint: string, expr: FXExpr): FXExpr => ctx.defineLocal(hint, expr);
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
      fn.call("min", fn.call("floor", fn.mul(fn.call("rand"), count)), fn.sub(count, fn.lit(1))),
    );
    const probability = fn.swizzle(texel(texelOf(column, FX_SURFACE_VERTEX_A)), "w");
    const alias = fn.swizzle(texel(texelOf(column, FX_SURFACE_VERTEX_B)), "w");
    // 1 keeps the column's own triangle, 0 takes its alias.
    const keep = fn.call("step", fn.call("rand"), probability);
    const triangle = local("mp_triangle", fn.call("mix", alias, column, keep));

    // Two draws in the unit square, the half past the diagonal folded back onto the triangle.
    const first = local("mp_u", fn.call("rand"));
    const second = local("mp_v", fn.call("rand"));
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
    ctx.setOutput("position", blend(FX_SURFACE_VERTEX_A, FX_SURFACE_VERTEX_B, FX_SURFACE_VERTEX_C));
    ctx.setOutput(
      "normal",
      fn.call("normalize", blend(FX_SURFACE_NORMAL_A, FX_SURFACE_NORMAL_B, FX_SURFACE_NORMAL_C)),
    );
  }
}
