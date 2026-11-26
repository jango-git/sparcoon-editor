import { describe, expect, it } from "vitest";

import type { GraphComment } from "../../src/domain/graphModel";
import { type CommentLevel, commentTree } from "../../src/domain/layout/commentTree";

function comment(id: string, x: number, y: number, width: number, height: number): GraphComment {
  return { id, text: id, position: { x, y }, size: { width, height } };
}

function card(id: string, x: number, y: number) {
  return { id, box: { x, y, width: 48, height: 48 } };
}

/** The tree as plain data: each level's cards and its comments by id. */
function shape(level: CommentLevel): unknown {
  return {
    cards: level.cards,
    blocks: Object.fromEntries(level.blocks.map((block) => [block.comment.id, shape(block)])),
  };
}

describe("commentTree", () => {
  it("gives a card to the smallest comment enclosing its centre, and nests comments", () => {
    const tree = commentTree(
      [comment("outer", 0, 0, 1000, 1000), comment("inner", 100, 100, 200, 200)],
      [card("a", 150, 150), card("b", 500, 500), card("c", 2000, 0)],
      [],
    );
    expect(shape(tree)).toEqual({
      cards: ["c"],
      blocks: { outer: { cards: ["b"], blocks: { inner: { cards: ["a"], blocks: {} } } } },
    });
  });

  it("nests the later of two comments the same size in the earlier", () => {
    const tree = commentTree(
      [comment("first", 0, 0, 400, 400), comment("second", 0, 0, 400, 400)],
      [card("a", 50, 50)],
      [],
    );
    expect(shape(tree)).toEqual({
      cards: [],
      blocks: { first: { cards: [], blocks: { second: { cards: ["a"], blocks: {} } } } },
    });
  });

  it("leaves out a comment holding no card, however deep", () => {
    const tree = commentTree(
      [comment("outer", 0, 0, 1000, 1000), comment("inner", 100, 100, 200, 200)],
      [card("a", 2000, 0)],
      [],
    );
    expect(shape(tree)).toEqual({ cards: ["a"], blocks: {} });
  });

  it("draws into a comment what lies on a path out of it and back", () => {
    const tree = commentTree(
      [comment("group", 0, 0, 400, 400)],
      [card("a", 50, 50), card("x", 1000, 0), card("b", 50, 250), card("y", 2000, 0)],
      [
        { from: "a", to: "x" },
        { from: "x", to: "b" },
        { from: "b", to: "y" },
      ],
    );
    expect(shape(tree)).toEqual({
      cards: ["y"],
      blocks: { group: { cards: ["a", "x", "b"], blocks: {} } },
    });
  });

  it("draws in a whole comment on such a path", () => {
    const tree = commentTree(
      [comment("group", 0, 0, 400, 400), comment("other", 1000, 0, 400, 400)],
      [card("a", 50, 50), card("x", 1050, 50), card("b", 50, 250)],
      [
        { from: "a", to: "x" },
        { from: "x", to: "b" },
      ],
    );
    expect(shape(tree)).toEqual({
      cards: [],
      blocks: {
        group: { cards: ["a", "b"], blocks: { other: { cards: ["x"], blocks: {} } } },
      },
    });
  });
});
