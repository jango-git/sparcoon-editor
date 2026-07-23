import { describe, expect, it } from "vitest";
import {
  GraphKind,
  NODE_PALETTE,
  RENDER_MODE_PARAM_KEY,
  RENDER_SORT_INTERVAL_PARAM,
  RENDER_SINK_TYPE,
  coerceRenderMode,
  coerceSortInterval,
  defaultParametersFor,
  isMeshExcludedRenderNode,
  metaFor,
  paletteForKind,
  sinkMeta,
  socketLabel,
} from "../../src/domain/nodePalette";

describe("nodePalette", () => {
  it("includes standard and manual nodes", () => {
    const types = new Set(NODE_PALETTE.map((meta) => meta.type));
    expect(types.has("constant")).toBe(true); // standard shared
    expect(types.has("ramp")).toBe(true); // standard behavior
    expect(types.has("color-ramp")).toBe(true); // standard shared color node
    expect(types.has("texture")).toBe(true); // manual render
    expect(types.has("read-attribute")).toBe(true); // manual behavior/render reader
    // store-attribute is authored via the sink attr slots, so it is hidden from the palette.
    expect(types.has("store-attribute")).toBe(false);
    expect(NODE_PALETTE.length).toBeGreaterThan(40);
  });

  it("excludes exactly the mesh-incompatible render nodes (derived from the two targets)", () => {
    const render = paletteForKind(GraphKind.Render);
    const excluded = (type: string): boolean => {
      const meta = render.find((m) => m.type === type);
      expect(meta, type).toBeDefined();
      return meta !== undefined && isMeshExcludedRenderNode(meta);
    };
    // Reads per-particle state a mesh (no simulation) can't provide -> hidden from a mesh palette.
    expect(excluded("life-ratio")).toBe(true);
    expect(excluded("camera-distance")).toBe(true);
    expect(excluded("read-attribute")).toBe(true); // attribute-dynamic reads
    expect(excluded("dissolve")).toBe(true); // reads PARTICLE_AGE/LIFETIME - the old hand-list gap
    // Reads only mesh-available inputs -> valid on a mesh, so shown (the old list wrongly dropped it).
    expect(excluded("animated-texture")).toBe(false);
    expect(excluded("constant")).toBe(false);
  });

  it("buckets by kind, with shared nodes in both", () => {
    const render = paletteForKind(GraphKind.Render);
    const behavior = paletteForKind(GraphKind.Behavior);

    expect(render.every((m) => m.domain === "render" || m.domain === "shared")).toBe(true);
    expect(behavior.every((m) => m.domain === "behavior" || m.domain === "shared")).toBe(true);

    // a shared node shows up in both palettes
    expect(render.some((m) => m.type === "constant")).toBe(true);
    expect(behavior.some((m) => m.type === "constant")).toBe(true);

    // a render-only node is absent from the behavior palette
    expect(behavior.some((m) => m.type === "spherical-clip")).toBe(false);
  });

  it("is sorted by category then type within a kind (a locale-free base order - the UI re-sorts by resolved label)", () => {
    const render = paletteForKind(GraphKind.Render);
    for (let i = 1; i < render.length; i++) {
      const previous = render[i - 1];
      const current = render[i];
      const order = previous.category.localeCompare(current.category);
      expect(order <= 0).toBe(true);
      if (order === 0) {
        expect(previous.type.localeCompare(current.type) <= 0).toBe(true);
      }
    }
  });

  it("resolves a node per graph kind; a shared node appears in both", () => {
    // life-ratio is a shared node, so it resolves in both the render and behavior palettes
    expect(metaFor(GraphKind.Render, "life-ratio")?.domain).toBe("shared");
    expect(metaFor(GraphKind.Behavior, "life-ratio")?.domain).toBe("shared");
    expect(metaFor(GraphKind.Render, "no-such-node")).toBeUndefined();
  });

  it("builds default parameters from the schema", () => {
    const clip = metaFor(GraphKind.Render, "spherical-clip");
    expect(clip).toBeDefined();
    const params = defaultParametersFor(clip!);
    // every schema param is present at its declared default
    for (const [key, spec] of Object.entries(clip!.params)) {
      expect(params[key]).toEqual(spec.default);
    }
  });

  it("humanizes socket labels when absent", () => {
    expect(socketLabel({ key: "inMin", type: "float" })).toBe("In Min");
    expect(socketLabel({ key: "color", type: "vec4", label: "Color" })).toBe("Color");
  });

  it("the surface sink exposes render mode + geometry + sort and no lighting model", () => {
    const surface = sinkMeta(RENDER_SINK_TYPE).params;
    expect(surface["model"]).toBeUndefined();
    expect(surface[RENDER_MODE_PARAM_KEY].type).toBe("enum");
    expect(surface["geometry"].type).toBe("enum");
    const sort = surface[RENDER_SORT_INTERVAL_PARAM];
    expect(sort).toMatchObject({ kind: "value", type: "float", default: 0, min: 0, step: 1 });
  });

  it("coerces the render sink's render mode and sort interval", () => {
    expect(coerceRenderMode("alphaTest")).toBe("alphaTest");
    expect(coerceRenderMode(undefined)).toBe("blending");
    expect(coerceRenderMode("bogus")).toBe("blending");

    // A whole, non-negative frame count; anything else floors to a valid interval (0 = off).
    expect(coerceSortInterval(0)).toBe(0);
    expect(coerceSortInterval(10)).toBe(10);
    expect(coerceSortInterval(2.9)).toBe(2);
    expect(coerceSortInterval(-4)).toBe(0);
    expect(coerceSortInterval(undefined)).toBe(0);
    expect(coerceSortInterval("3")).toBe(3);
  });
});
