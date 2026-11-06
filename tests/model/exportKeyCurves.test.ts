import { describe, expect, it } from "vitest";
import { tracksLiteral, transformTracksLiteral } from "../../src/persistence/exportLiterals";

describe("export key curves", () => {
  it("writes a key's curve only when it has one, and never the editor's key id", () => {
    const literal = JSON.parse(
      tracksLiteral(
        [
          {
            name: "glow",
            keys: [
              { id: "k1", time: 0, value: 0, ease: "in" },
              { id: "k2", time: 1, value: 1 },
            ],
          },
        ],
        [],
      ),
    ) as { keys: unknown[] }[];
    expect(literal[0]?.keys).toEqual([
      { time: 0, value: 0, ease: "in" },
      { time: 1, value: 1 },
    ]);
    const transform = JSON.parse(
      transformTracksLiteral(
        [{ channel: "scale", keys: [{ id: "k", time: 0, value: [1, 1, 1], ease: "out" }] }],
        [],
      ),
    ) as { keys: unknown[] }[];
    expect(transform[0]?.keys).toEqual([{ time: 0, value: [1, 1, 1], ease: "out" }]);
  });
});
