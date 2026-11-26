/**
 * Which cards and comments each comment holds. A comment holds what its box encloses - a card or a
 * comment whose centre lies inside it - and of several comments enclosing one card, the innermost
 * holds it: the smallest, or of two the same size the later in the document. Comments holding no
 * card are left out.
 *
 * The auto-layout lays each comment out as one block, inputs entering on its left, outputs leaving
 * on its right. A path from a comment's card out to another card or comment and back in would have
 * to run right to left, so whatever lies on such a path is drawn into the comment.
 */

import type { GraphComment, GraphPosition, GraphSize } from "../graphModel";

/** Room left between a comment's frame and what it holds, in grid cells. */
export const COMMENT_PADDING_CELLS = 2;

export interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * A comment's frame round `bounds`, on the grid: the padding on every side, but none on a side
 * marked `flush` (where the block's ports stand on its edge), and `header` px more on top.
 */
export function commentFrame(
  bounds: Bounds,
  header: number,
  grid: number,
  flush: { readonly left: boolean; readonly right: boolean } = { left: false, right: false },
): { readonly position: GraphPosition; readonly size: GraphSize } {
  const padding = COMMENT_PADDING_CELLS * grid;
  const left = Math.floor((bounds.left - (flush.left ? 0 : padding)) / grid) * grid;
  const right = Math.ceil((bounds.right + (flush.right ? 0 : padding)) / grid) * grid;
  const top = Math.floor((bounds.top - padding - header) / grid) * grid;
  const bottom = Math.ceil((bounds.bottom + padding) / grid) * grid;
  return { position: { x: left, y: top }, size: { width: right - left, height: bottom - top } };
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Whether `comment` encloses `box`: the box's centre lies inside it. */
export function encloses(comment: GraphComment, box: Box): boolean {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  return (
    x >= comment.position.x &&
    x <= comment.position.x + comment.size.width &&
    y >= comment.position.y &&
    y <= comment.position.y + comment.size.height
  );
}

/** Cards and comments side by side: the whole graph, or what one comment holds. */
export interface CommentLevel {
  /** Cards held directly, in document order. */
  readonly cards: readonly string[];
  readonly blocks: readonly CommentBlock[];
}

export interface CommentBlock extends CommentLevel {
  readonly comment: GraphComment;
}

interface MutableLevel {
  cards: string[];
  blocks: MutableBlock[];
}

interface MutableBlock extends MutableLevel {
  readonly comment: GraphComment;
}

/**
 * The graph's cards and comments as a tree. `cards` are in document order with their boxes, and
 * `edges` are the wires between cards.
 */
export function commentTree(
  comments: readonly GraphComment[],
  cards: readonly { readonly id: string; readonly box: Box }[],
  edges: readonly { readonly from: string; readonly to: string }[],
): CommentLevel {
  const area = (comment: GraphComment): number => comment.size.width * comment.size.height;
  const order = new Map(comments.map((comment, position) => [comment, position]));
  const innermostFirst = [...comments].sort(
    (first, second) =>
      area(first) - area(second) || (order.get(second) ?? 0) - (order.get(first) ?? 0),
  );
  /** The innermost comment enclosing `box` among those after the first `skip` innermost. */
  const innermostEnclosing = (box: Box, skip: number): GraphComment | undefined =>
    innermostFirst.slice(skip).find((comment) => encloses(comment, box));

  const blocks = new Map<GraphComment, MutableBlock>(
    comments.map((comment) => [comment, { comment, cards: [], blocks: [] }]),
  );
  const root: MutableLevel = { cards: [], blocks: [] };
  const levelOf = (comment: GraphComment | undefined): MutableLevel =>
    comment === undefined ? root : (blocks.get(comment) ?? root);
  for (const card of cards) {
    levelOf(innermostEnclosing(card.box, 0)).cards.push(card.id);
  }
  for (const comment of comments) {
    const block = blocks.get(comment);
    if (block !== undefined) {
      const box = { ...comment.position, ...comment.size };
      levelOf(innermostEnclosing(box, innermostFirst.indexOf(comment) + 1)).blocks.push(block);
    }
  }

  const cardOrder = new Map(cards.map((card, position) => [card.id, position]));
  const targets = new Map<string, string[]>();
  for (const edge of edges) {
    targets.set(edge.from, [...(targets.get(edge.from) ?? []), edge.to]);
  }
  pruneEmpty(root);
  resolveLoops(root, targets, cardOrder);
  return root;
}

/** Drops the comments holding no card, however deep. */
function pruneEmpty(level: MutableLevel): boolean {
  level.blocks = level.blocks.filter((block) => pruneEmpty(block));
  return level.cards.length > 0 || level.blocks.length > 0;
}

/** Draws into each block what lies on a path out of it and back, then does so inside it. */
function resolveLoops(
  level: MutableLevel,
  targets: ReadonlyMap<string, readonly string[]>,
  order: ReadonlyMap<string, number>,
): void {
  for (;;) {
    const unitOf = new Map<string, string | MutableBlock>();
    for (const card of level.cards) {
      unitOf.set(card, card);
    }
    for (const block of level.blocks) {
      for (const card of cardsIn(block)) {
        unitOf.set(card, block);
      }
    }
    const next = new Map<string | MutableBlock, Set<string | MutableBlock>>();
    const previous = new Map<string | MutableBlock, Set<string | MutableBlock>>();
    for (const [card, unit] of unitOf) {
      for (const target of targets.get(card) ?? []) {
        const targetUnit = unitOf.get(target);
        if (targetUnit !== undefined && targetUnit !== unit) {
          next.set(unit, (next.get(unit) ?? new Set()).add(targetUnit));
          previous.set(targetUnit, (previous.get(targetUnit) ?? new Set()).add(unit));
        }
      }
    }
    const looping = level.blocks
      .map((block) => {
        const ahead = reach(block, next);
        return { block, drawn: [...reach(block, previous)].filter((unit) => ahead.has(unit)) };
      })
      .find(({ drawn }) => drawn.length > 0);
    if (looping === undefined) {
      break;
    }
    const { block, drawn } = looping;
    for (const unit of drawn) {
      if (typeof unit === "string") {
        level.cards = level.cards.filter((card) => card !== unit);
        block.cards.push(unit);
      } else {
        level.blocks = level.blocks.filter((other) => other !== unit);
        block.blocks.push(unit);
      }
    }
    block.cards.sort((first, second) => (order.get(first) ?? 0) - (order.get(second) ?? 0));
  }
  for (const block of level.blocks) {
    resolveLoops(block, targets, order);
  }
}

/** Every unit reachable from `start` along `links`, `start` excluded. */
function reach<T>(start: T, links: ReadonlyMap<T, ReadonlySet<T>>): Set<T> {
  const seen = new Set<T>();
  const stack = [start];
  for (let unit = stack.pop(); unit !== undefined; unit = stack.pop()) {
    for (const next of links.get(unit) ?? []) {
      if (next !== start && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Every card a level holds, however deep. */
export function cardsIn(level: CommentLevel): string[] {
  return [...level.cards, ...level.blocks.flatMap(cardsIn)];
}

/** Where each card stands among the items of a level. */
export interface CommentIndex {
  /** What stands for `card` among `level`'s items: itself, the block holding it, or nothing. */
  unitAt(level: CommentLevel, card: string): string | CommentBlock | undefined;
}

export function indexComments(tree: CommentLevel): CommentIndex {
  const owner = new Map<string, CommentLevel>();
  const parent = new Map<CommentBlock, CommentLevel>();
  const visit = (level: CommentLevel): void => {
    for (const card of level.cards) {
      owner.set(card, level);
    }
    for (const block of level.blocks) {
      parent.set(block, level);
      visit(block);
    }
  };
  visit(tree);
  return {
    unitAt: (level, card): string | CommentBlock | undefined => {
      const holder = owner.get(card);
      if (holder === level) {
        return card;
      }
      for (let block = holder; block !== undefined && isBlock(block);) {
        const up = parent.get(block);
        if (up === level) {
          return block;
        }
        block = up;
      }
      return undefined;
    },
  };
}

function isBlock(level: CommentLevel): level is CommentBlock {
  return "comment" in level;
}
