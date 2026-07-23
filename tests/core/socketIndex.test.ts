import { describe, expect, it } from "vitest";
import { inputSocket, outputSocket } from "../../src/engine/core/compiler/FXSocketIndex.Internal";
import { FakeNode, socket } from "../helpers/fakeNodes";

describe("FXSocketIndex", () => {
  it("looks up input and output sockets by key", () => {
    const node = new FakeNode({
      type: "n",
      inputs: [socket("a", "float"), socket("b", "vec3")],
      outputs: [socket("out", "vec4")],
    });

    expect(inputSocket(node, "b")?.type.glslTypeName).toBe("vec3");
    expect(outputSocket(node, "out")?.type.glslTypeName).toBe("vec4");
  });

  it("returns undefined for an unknown key", () => {
    const node = new FakeNode({ type: "n", inputs: [socket("a")] });
    expect(inputSocket(node, "missing")).toBeUndefined();
    expect(outputSocket(node, "a")).toBeUndefined();
  });

  it("keeps the first descriptor when a key is duplicated (matches the old scan)", () => {
    const first = socket("dup", "float");
    const second = socket("dup", "vec2");
    const node = new FakeNode({ type: "n", inputs: [first, second] });

    expect(inputSocket(node, "dup")).toBe(first);
  });
});
