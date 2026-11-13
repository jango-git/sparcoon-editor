import { describe, expect, it } from "vitest";

import type { FXTypedLocal } from "../../src/engine/core/codegen/drawStage.Internal";
import { projectComponents } from "../../src/engine/core/codegen/projectComponents.Internal";
import { scalarize } from "../../src/engine/core/codegen/scalarize.Internal";
import type { FXExpr } from "../../src/engine/core/ir/FXExpr";
import {
  add,
  construct,
  lit,
  litVec,
  mul,
  neg,
  raw,
  ref,
  select,
  sub,
  swizzle,
} from "../../src/engine/core/ir/FXExprBuilder";
import type { FXValueType } from "../../src/engine/core/socket/FXValueType";
import { FX_VALUE_TYPES } from "../../src/engine/core/socket/FXValueType";
import { call } from "../helpers/exprCall";

const { float: FLOAT, vec2: VEC2, vec3: VEC3, vec4: VEC4, mat3: MAT3, mat4: MAT4 } = FX_VALUE_TYPES;

const local = (name: string, expr: FXExpr, type: FXValueType = expr.type): FXTypedLocal => ({
  name,
  expr,
  type,
});
const read = (name: string, type: FXValueType): FXExpr => ref("local", name, type);
const uniform = (name: string, type: FXValueType): FXExpr => ref("uniform", name, type);

/** Projects `locals` onto components `channels` of `root`, naming new locals `p0`, `p1`, ... */
function project(locals: readonly FXTypedLocal[], root: string, channels: readonly number[]) {
  let next = 0;
  return projectComponents(locals, [{ name: root, channels }], {
    nextName: () => `p${String(next++)}`,
    derive: (_local, name, type, expr) => ({ name, type, expr }),
  });
}

/** The projected value of the root: its local's expression. */
function rootExpr(projection: ReturnType<typeof project>): FXExpr {
  const name = projection.roots[0];
  const found = projection.locals.find((each) => each.name === name);
  if (found === undefined) {
    throw new Error(`no root local "${name}"`);
  }
  return found.expr;
}

describe("projectComponents", () => {
  it("reads an alpha straight off the constructor argument it comes from", () => {
    const rgb = local("rgb", mul(uniform("u_tint", VEC3), uniform("u_glow", FLOAT)));
    const alpha = local("alpha", uniform("u_alpha", FLOAT));
    const albedo = local("albedo", construct(VEC4, read("rgb", VEC3), read("alpha", FLOAT)));
    const projection = project([rgb, alpha, albedo], "albedo", [3]);
    // The color chain is not read at all; the alpha local is the plan's own, shared.
    expect(projection.locals.map((each) => each.name)).toEqual(["alpha"]);
    expect(projection.roots).toEqual(["alpha"]);
    expect(projection.locals[0]).toBe(alpha);
  });

  it("cuts an element-wise chain down to one component, operation by operation", () => {
    const a = local("a", mul(uniform("u_a", VEC4), uniform("u_s", FLOAT)));
    const m = local("m", call("mix", read("a", VEC4), uniform("u_b", VEC4), uniform("u_t", FLOAT)));
    const projection = project([a, m], "m", [3]);
    expect(projection.locals.map((each) => each.type.id)).toEqual(["float", "float"]);
    const [cutA, cutM] = projection.locals;
    expect(cutA.expr).toEqual(mul(swizzle(uniform("u_a", VEC4), "w"), uniform("u_s", FLOAT)));
    expect(cutM.expr).toEqual(
      call(
        "mix",
        read(cutA.name, FLOAT),
        swizzle(uniform("u_b", VEC4), "w"),
        uniform("u_t", FLOAT),
      ),
    );
  });

  it("keeps a local read whole by one reader whole for every reader, shared with the plan", () => {
    const v = local("v", add(uniform("u_a", VEC3), uniform("u_b", VEC3)));
    const n = local("n", call("normalize", read("v", VEC3)));
    const out = local("out", construct(VEC4, read("n", VEC3), call("length", read("v", VEC3))));
    const projection = project([v, n, out], "out", [3]);
    // `length` mixes the components of `v`: the plan's own `v`, untouched.
    expect(projection.locals[0]).toBe(v);
    expect(projection.locals.map((each) => each.name)).toEqual(["v", "p0"]);
    expect(rootExpr(projection)).toEqual(call("length", read("v", VEC3)));
  });

  it("reads raw code whole and takes its component after", () => {
    const sample = local("sample", raw(VEC4, "glsl", "fxSample_u_tex($0)", uniform("u_uv", VEC2)));
    const projection = project([sample], "sample", [3]);
    expect(projection.locals).toHaveLength(1);
    expect(rootExpr(projection)).toEqual(swizzle(sample.expr, "w"));
  });

  it("composes swizzles and keeps a reorder the reader asked for", () => {
    const v = local("v", add(uniform("u_a", VEC4), uniform("u_b", VEC4)));
    const s = local("s", swizzle(read("v", VEC4), "wzyx"));
    const projection = project([v, s], "s", [0, 1]);
    // Components 0 and 1 of `s` are `v.w` and `v.z`: `v` is cut to its z and w.
    const [cutV, cutS] = projection.locals;
    expect(cutV.type).toBe(VEC2);
    expect(cutV.expr).toEqual(
      add(swizzle(uniform("u_a", VEC4), "zw"), swizzle(uniform("u_b", VEC4), "zw")),
    );
    expect(cutS.expr).toEqual(swizzle(read(cutV.name, VEC2), "yx"));
  });

  it("reads a matrix whole", () => {
    const m = local("m", mul(uniform("u_m", MAT4), uniform("u_n", MAT4)));
    const projection = project(
      [m],
      "m",
      Array.from({ length: 16 }, (_, i) => i),
    );
    expect(projection.locals[0]).toBe(m);
    expect(projection.roots).toEqual(["m"]);
  });

  it("keeps what a matrix reads: a value read through one is read whole", () => {
    const v = local("v", add(uniform("u_a", VEC3), uniform("u_b", VEC3)));
    const m = local("m", construct(MAT3, read("v", VEC3), read("v", VEC3), read("v", VEC3)));
    const o = local("o", mul(read("m", MAT3), uniform("u_c", VEC3)));
    const projection = project([v, m, o], "o", [0]);
    expect(projection.locals.slice(0, 2)).toEqual([v, m]);
    expect(rootExpr(projection)).toEqual(swizzle(o.expr, "x"));
  });

  it("gives back the plan's own locals when nothing they read is cut", () => {
    const v = local("v", add(uniform("u_a", VEC4), uniform("u_b", VEC4)));
    const s = local("s", swizzle(read("v", VEC4), "xy"));
    const o = local("o", construct(VEC4, read("s", VEC2), swizzle(read("v", VEC4), "zw")));
    const projection = project([v, s, o], "o", [0, 1, 2, 3]);
    expect(projection.roots).toEqual(["o"]);
    projection.locals.forEach((each, index) => {
      expect(each).toBe([v, s, o][index]);
    });
    // A swizzle of a uniform read whole is the plan's own too.
    const scaled = local(
      "scaled",
      mul(swizzle(uniform("u_c", VEC4), "xyz"), uniform("u_k", FLOAT)),
    );
    expect(project([scaled], "scaled", [0, 1, 2]).locals[0]).toBe(scaled);
  });

  it("reads an integer constructor argument whole rather than cutting it", () => {
    const c = local(
      "c",
      construct(VEC4, uniform("u_i", FX_VALUE_TYPES.ivec2), uniform("u_f", VEC2)),
    );
    const projection = project([c], "c", [0]);
    expect(rootExpr(projection)).toEqual(swizzle(c.expr, "x"));
  });

  it("serves two roots reading different components of one local", () => {
    const v = local("v", add(uniform("u_a", VEC4), uniform("u_b", VEC4)));
    let next = 0;
    const projection = projectComponents(
      [v],
      [
        { name: "v", channels: [3] },
        { name: "v", channels: [0] },
      ],
      {
        nextName: () => `p${String(next++)}`,
        derive: (_local, name, type, expr) => ({ name, type, expr }),
      },
    );
    // `v` is cut to its x and w, each root reading its own component of the cut local.
    const [cut] = projection.locals;
    expect(cut.type).toBe(VEC2);
    const valueOf = (name: string | undefined): FXExpr | undefined =>
      projection.locals.find((each) => each.name === name)?.expr;
    expect(valueOf(projection.roots[0])).toEqual(swizzle(read(cut.name, VEC2), "y"));
    expect(valueOf(projection.roots[1])).toEqual(swizzle(read(cut.name, VEC2), "x"));
  });

  it("drops what the roots do not read", () => {
    const unused = local("unused", uniform("u_x", VEC4));
    const used = local("used", uniform("u_y", VEC4));
    expect(project([unused, used], "used", [0, 1, 2, 3]).locals).toEqual([used]);
  });
});

/** A value of `type` the leaves of {@link randomExpr} read. */
const leaves = (type: FXValueType, seed: number): FXExpr =>
  seed % 3 === 0
    ? type.components === 1
      ? lit(seed * 0.25)
      : litVec(...Array.from({ length: type.components }, (_, i) => seed + i))
    : uniform(`u_${type.id}_${String(seed % 4)}`, type);

/** A deterministic pseudo-random float/vecN expression `depth` levels deep. */
function randomExpr(type: FXValueType, depth: number, seed: number): FXExpr {
  if (depth === 0) {
    return leaves(type, seed);
  }
  const child = (offset: number, childType: FXValueType = type): FXExpr =>
    randomExpr(childType, depth - 1, seed * 7 + offset);
  const vector = type.components > 1;
  switch (seed % (vector ? 8 : 6)) {
    case 0:
      return add(child(1), child(2));
    case 1:
      return mul(child(1), child(2, FLOAT));
    case 2:
      return neg(child(1));
    case 3:
      return call("clamp", child(1), child(2, FLOAT), child(3, FLOAT));
    case 4:
      return select(child(1, FLOAT), child(2), child(3));
    case 5:
      return sub(child(1), child(2));
    case 6:
      return construct(
        type,
        child(1, FLOAT),
        child(2, [FLOAT, VEC2, VEC3][type.components - 2] ?? FLOAT),
      );
    default:
      return swizzle(child(1, VEC4), "wzyx".slice(0, type.components));
  }
}

describe("projectComponents - each component as the whole value's", () => {
  // A component of the projection scalarizes exactly as that component of the whole value does.
  it.each(Array.from({ length: 40 }, (_, index) => index))("random value %i", (seed) => {
    const type = [VEC2, VEC3, VEC4][seed % 3] ?? VEC4;
    const expr = randomExpr(type, 3, seed + 1);
    const whole = scalarize(expr);
    for (let channel = 0; channel < type.components; channel++) {
      const projection = project([local("value", expr)], "value", [channel]);
      expect(scalarize(rootExpr(projection))).toEqual([whole[channel]]);
    }
  });
});
