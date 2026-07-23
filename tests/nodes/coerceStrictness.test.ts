import { describe, expect, it } from "vitest";
import { FX_STANDARD_NODES } from "../../src/engine/nodes-std/index";
import type { FXNodeDefinition } from "../../src/engine/core/nodes/defineNode";

function def(type: string): FXNodeDefinition {
  const found = FX_STANDARD_NODES.find((d) => d.type === type);
  if (found === undefined) {
    throw new Error(`no descriptor "${type}"`);
  }
  return found;
}

describe("curve coerce strictness (M6)", () => {
  it("rejects a non-finite curve point instead of baking a NaN LUT", () => {
    const node = def("ramp").createInstance("behavior");
    expect(() => node.applyParams?.({ curve: { points: [{ position: "x", value: 1 }] } })).toThrow(
      /FXNodeDefinition/,
    );
    expect(() =>
      node.applyParams?.({ curve: { points: [{ position: 0, value: Number.NaN }] } }),
    ).toThrow(/FXNodeDefinition/);
    // A well-formed curve still applies.
    expect(() =>
      node.applyParams?.({
        curve: {
          points: [
            { position: 0, value: 0 },
            { position: 1, value: 2 },
          ],
        },
      }),
    ).not.toThrow();
  });
});

describe("animated-texture grid dimension bounds (M7)", () => {
  // `columns`/`rows` are editable float pins bounded to [1, 64]; a snapshot value outside
  // that range (or non-finite) is rejected as bad-param by the descriptor's coerce.
  const make = () => def("animated-texture").createInstance("render");

  it("rejects a < 1 / non-number grid dimension as bad-param", () => {
    for (const bad of [0, -2, "x", Number.NaN]) {
      expect(() => make().applyParams?.({ columns: bad })).toThrow(/columns/);
      expect(() => make().applyParams?.({ rows: bad })).toThrow(/rows/);
    }
  });

  it("accepts a valid in-range grid dimension", () => {
    expect(() => make().applyParams?.({ columns: 4, rows: 3 })).not.toThrow();
  });
});

describe("socket default metadata (M8)", () => {
  const socketDefault = (type: string, key: string): unknown => {
    const meta = def(type).describe();
    return meta.inputs.find((s) => s.key === key)?.default;
  };

  it("surfaces an editable inline default via `control`", () => {
    // clamp: lo/hi are editable pins defaulting to 0/1; mix: t defaults to 0.5. These are
    // the "value on the pin" - baked inline when unconnected, not a uniform/binding.
    const control = (type: string, key: string): unknown =>
      def(type)
        .describe()
        .inputs.find((s) => s.key === key)?.control;
    expect(control("clamp", "lo")).toEqual({ default: 0 });
    expect(control("clamp", "hi")).toEqual({ default: 1 });
    expect(control("mix", "t")).toEqual({ default: 0.5 });
  });

  it("surfaces a target-input default as { targetInput }", () => {
    // rotate-uv: the `uv` input defaults to the particle UV builtin.
    expect(socketDefault("rotate-uv", "uv")).toEqual({ targetInput: "p_uv" });
  });

  it("omits the static default on a required socket with only an inline control", () => {
    // binary-op inputs a/b are required (so the contract-test harness still wires a
    // stub constant to pin T) but also carry an editable inline pin value, sized from
    // whatever the graph resolves T to - there is no static (non-editable) `default`.
    const meta = def("binary-op").describe();
    const a = meta.inputs.find((s) => s.key === "a");
    expect(a?.required).toBe(true);
    expect("default" in (a ?? {})).toBe(false);
    expect(a?.control).toEqual({ default: 0 });
  });

  it("keeps every socket default JSON-serializable", () => {
    for (const d of FX_STANDARD_NODES) {
      expect(() => JSON.stringify(d.describe())).not.toThrow();
    }
  });
});
