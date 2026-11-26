/**
 * Vertical placement for the auto-layout: alternating sweeps over the layers, each entity asking
 * for the height that lines its socket up with the median of its neighbours' (so most wires run
 * straight), then each layer packed without overlap by isotonic regression - the placement closest
 * to every ask that keeps the layer's order and spacing. Writes each entity's `y`.
 */

import type { LayeredGraph, LayoutEntity, LayoutLink } from "./layeredGraph";

const SWEEP_PAIRS = 8;
/** Gap between the sinks as first stacked: room for their feeders to settle between them. */
const SINK_SEED_GAP_CELLS = 4;

/** A link's height where it leaves its source's socket, and where it enters its target's. */
export function sourceRow(link: LayoutLink): number {
  return link.from.entity.y + link.from.entity.outputRow(link.from.socketKey);
}

export function targetRow(link: LayoutLink): number {
  return link.to.entity.y + link.to.entity.inputRow(link.to.socketKey);
}

/** The gap kept between two entities stacked in a layer: none between two placeholders. */
function gapBetween(upper: LayoutEntity, lower: LayoutEntity, grid: number): number {
  return upper.signal !== undefined && lower.signal !== undefined ? 0 : grid;
}

export function placeRows(layered: LayeredGraph, grid: number): void {
  const { layers, outgoing, incoming } = layered;

  // Sinks keep their authored order, stacked; everything else starts as a plain column.
  const sinks = layers[0] ?? [];
  sinks.sort((first, second) => first.y - second.y);
  let top = 0;
  for (const sink of sinks) {
    sink.y = top;
    top += sink.height + grid * SINK_SEED_GAP_CELLS;
  }
  for (const layer of layers.slice(1)) {
    layer.forEach((entity, index) => {
      entity.y = index * grid * 8;
    });
  }

  const towardTargets = (entity: LayoutEntity): readonly number[] =>
    (outgoing.get(entity) ?? []).map(
      (link) => targetRow(link) - entity.outputRow(link.from.socketKey),
    );
  const towardSources = (entity: LayoutEntity): readonly number[] =>
    (incoming.get(entity) ?? []).map(
      (link) => sourceRow(link) - entity.inputRow(link.to.socketKey),
    );
  const sweepLeftward = (): void => {
    for (const layer of layers.slice(1)) {
      packLayer(layer, towardTargets, grid);
    }
  };
  const sweepRightward = (): void => {
    for (let index = layers.length - 2; index >= 0; index--) {
      const layer = layers[index];
      if (layer !== undefined) {
        packLayer(layer, towardSources, grid);
      }
    }
  };

  sweepLeftward();
  for (let pass = 0; pass < SWEEP_PAIRS; pass++) {
    sweepRightward();
    sweepLeftward();
  }
  closeComponentGaps(layered, grid);
  untangleTurnCycles(layered, grid);
}

/**
 * Parts of a level no wire joins are placed independently by the sweeps and can drift apart,
 * leaving empty space between them. Taken top to bottom, each part is moved up as far as the
 * columns it shares with the parts above allow, spacing kept. A part that interleaves with those
 * above in some column keeps its place.
 */
function closeComponentGaps(layered: LayeredGraph, grid: number): void {
  const { layers, links } = layered;
  const parent = new Map<LayoutEntity, LayoutEntity>();
  const root = (entity: LayoutEntity): LayoutEntity => {
    let current = entity;
    for (;;) {
      const next = parent.get(current);
      if (next === undefined || next === current) {
        return current;
      }
      current = next;
    }
  };
  for (const link of links) {
    const from = root(link.from.entity);
    const to = root(link.to.entity);
    if (from !== to) {
      parent.set(from, to);
    }
  }
  const components = new Map<LayoutEntity, LayoutEntity[]>();
  for (const layer of layers) {
    for (const entity of layer) {
      const key = root(entity);
      const members = components.get(key) ?? [];
      members.push(entity);
      components.set(key, members);
    }
  }
  if (components.size < 2) {
    return;
  }
  const top = (members: readonly LayoutEntity[]): number =>
    Math.min(...members.map((entity) => entity.y));
  const ordered = [...components.values()].sort((first, second) => top(first) - top(second));
  /** The lowest entity placed so far in each layer. */
  const lowest = new Map<number, LayoutEntity>();
  const place = (members: readonly LayoutEntity[]): void => {
    for (const entity of members) {
      const known = lowest.get(entity.layer);
      if (known === undefined || known.y + known.height < entity.y + entity.height) {
        lowest.set(entity.layer, entity);
      }
    }
  };
  const [first, ...rest] = ordered;
  place(first ?? []);
  for (const members of rest) {
    const highest = new Map<number, LayoutEntity>();
    for (const entity of members) {
      const known = highest.get(entity.layer);
      if (known === undefined || entity.y < known.y) {
        highest.set(entity.layer, entity);
      }
    }
    let room = Infinity;
    for (const [layer, upper] of highest) {
      const above = lowest.get(layer);
      if (above !== undefined) {
        room = Math.min(room, upper.y - (above.y + above.height + gapBetween(above, upper, grid)));
      }
    }
    if (room === Infinity) {
      room = top(members) - Math.min(...[...lowest.values()].map((entity) => entity.y));
    }
    const shift = Math.floor(room / grid) * grid;
    if (shift > 0) {
      for (const entity of members) {
        entity.y -= shift;
      }
    }
    place(members);
  }
}

/** Passes of {@link untangleTurnCycles}: each fix can expose a cycle in a neighbouring channel. */
const UNTANGLE_PASSES = 6;
/** How many cells an entity may be nudged to break a cycle. */
const NUDGE_CELLS = [1, -1, 2, -2, 3, -3];

/** A signal's crossing of one channel: where it leaves, and its links that change row. */
interface TurningCrossing {
  readonly sourceRow: number;
  readonly turns: readonly LayoutLink[];
}

/**
 * In a channel a signal turning on a lane must turn before (left of) any signal arriving on the
 * row it leaves. Those rules can form a cycle - two signals trading rows, or more passing rows round
 * - and then no lanes satisfy them all. Each cycle is broken here by moving one of the entities on
 * its coinciding rows: two placeholders on one side of a trade swap rows (both signals then run
 * straight), otherwise a placeholder, or failing that a card, moves to a free cell nearby. A move
 * that leaves both channels beside what moved free of cycles is taken first, so a trade is not just
 * passed to the next channel or a card rocked back and forth. Either keeps the packing valid.
 */
function untangleTurnCycles(layered: LayeredGraph, grid: number): void {
  const { layers, links } = layered;
  /** The links from layer `layer` to the one on its right. */
  const channel = (layer: number): LayoutLink[] =>
    links.filter((link) => link.from.entity.layer === layer && link.to.entity.layer === layer - 1);
  const fitsAt = (entity: LayoutEntity, y: number): boolean =>
    (layers[entity.layer] ?? []).every(
      (other) =>
        other === entity ||
        other.y + other.height + gapBetween(other, entity, grid) <= y ||
        y + entity.height + gapBetween(entity, other, grid) <= other.y,
    );
  /** Whether the channels on both sides of `entity` are free of cycles. */
  const settled = (entity: LayoutEntity): boolean =>
    turnCycle(channel(entity.layer)) === undefined &&
    turnCycle(channel(entity.layer + 1)) === undefined;
  /** Moves `entity` to a free cell nearby, one that settles it when `settling`. */
  const nudge = (entity: LayoutEntity, settling: boolean): boolean => {
    const start = entity.y;
    for (const cells of NUDGE_CELLS) {
      const y = start + cells * grid;
      if (fitsAt(entity, y)) {
        entity.y = y;
        if (!settling || settled(entity)) {
          return true;
        }
      }
    }
    entity.y = start;
    return false;
  };
  /** Breaks a cycle given as its links: each arrives on the row the previous crossing leaves. */
  const untangle = (cycle: readonly LayoutLink[]): boolean => {
    const first = cycle[0];
    const second = cycle[1];
    if (cycle.length === 2 && first !== undefined && second !== undefined) {
      for (const [upper, lower] of [
        [first.to.entity, second.to.entity],
        [first.from.entity, second.from.entity],
      ] as const) {
        if (upper.signal !== undefined && lower.signal !== undefined) {
          [upper.y, lower.y] = [lower.y, upper.y];
          if (settled(upper)) {
            return true;
          }
          [upper.y, lower.y] = [lower.y, upper.y];
        }
      }
    }
    const entities = cycle.flatMap((link) => [link.from.entity, link.to.entity]);
    const placeholders = entities.filter((entity) => entity.signal !== undefined);
    const cards = entities.filter((entity) => entity.signal === undefined);
    return [true, false].some((settling) =>
      [...placeholders, ...cards].some((entity) => nudge(entity, settling)),
    );
  };

  for (let pass = 0; pass < UNTANGLE_PASSES; pass++) {
    let changed = false;
    for (let layer = layers.length - 1; layer >= 1; layer--) {
      const cycle = turnCycle(channel(layer));
      if (cycle !== undefined && untangle(cycle)) {
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
  }
}

/**
 * A cycle of the channel's turn-first rules, as the links that arrive on the row the previous
 * crossing in the cycle leaves; `undefined` when there is none.
 */
function turnCycle(channel: readonly LayoutLink[]): LayoutLink[] | undefined {
  const crossings = new Map<LayoutLink["signal"], TurningCrossing>();
  for (const link of channel) {
    const known = crossings.get(link.signal);
    const turns = targetRow(link) === sourceRow(link) ? [] : [link];
    crossings.set(link.signal, {
      sourceRow: sourceRow(link),
      turns: [...(known?.turns ?? []), ...turns],
    });
  }
  const turning = [...crossings.values()].filter((crossing) => crossing.turns.length > 0);
  /** The rules out of a crossing: each later crossing's link arriving on the row it leaves. */
  const rulesOf = (crossing: TurningCrossing): { next: TurningCrossing; link: LayoutLink }[] =>
    turning.flatMap((next) =>
      next === crossing
        ? []
        : next.turns
            .filter((link) => targetRow(link) === crossing.sourceRow)
            .map((link) => ({ next, link })),
    );
  const state = new Map<TurningCrossing, "open" | "done">();
  const path: LayoutLink[] = [];
  const pathCrossings: TurningCrossing[] = [];
  const visit = (crossing: TurningCrossing): LayoutLink[] | undefined => {
    state.set(crossing, "open");
    pathCrossings.push(crossing);
    for (const { next, link } of rulesOf(crossing)) {
      if (state.get(next) === "open") {
        return [...path.slice(pathCrossings.indexOf(next)), link];
      }
      if (state.get(next) === undefined) {
        path.push(link);
        const found = visit(next);
        if (found !== undefined) {
          return found;
        }
        path.pop();
      }
    }
    pathCrossings.pop();
    state.set(crossing, "done");
    return undefined;
  };
  for (const crossing of turning) {
    if (state.get(crossing) === undefined) {
      const found = visit(crossing);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * Re-orders `layer` by where each entity asks to be (the median of `asks`, or where it is) and
 * places it as close to those asks as its order and spacing allow (pool-adjacent-violators over
 * the asks with the stacking offsets taken out), snapped to the grid.
 */
function packLayer(
  layer: LayoutEntity[],
  asks: (entity: LayoutEntity) => readonly number[],
  grid: number,
): void {
  const ordered = layer
    .map((entity, index) => ({ entity, index, wanted: median(asks(entity)) ?? entity.y }))
    .sort((first, second) => first.wanted - second.wanted || first.index - second.index);

  interface Block {
    sum: number;
    weight: number;
    readonly members: { readonly entity: LayoutEntity; readonly offset: number }[];
  }
  const blocks: Block[] = [];
  let offset = 0;
  let previous: LayoutEntity | undefined;
  for (const { entity, wanted } of ordered) {
    if (previous !== undefined) {
      offset += previous.height + gapBetween(previous, entity, grid);
    }
    previous = entity;
    blocks.push({
      sum: (wanted - offset) * entity.weight,
      weight: entity.weight,
      members: [{ entity, offset }],
    });
    for (;;) {
      const last = blocks[blocks.length - 1];
      const beforeLast = blocks[blocks.length - 2];
      if (
        last === undefined ||
        beforeLast === undefined ||
        beforeLast.sum / beforeLast.weight <= last.sum / last.weight
      ) {
        break;
      }
      blocks.pop();
      beforeLast.sum += last.sum;
      beforeLast.weight += last.weight;
      beforeLast.members.push(...last.members);
    }
  }
  for (const block of blocks) {
    const start = Math.round(block.sum / block.weight / grid) * grid;
    for (const member of block.members) {
      member.entity.y = start + member.offset;
    }
  }
  layer.splice(0, layer.length, ...ordered.map(({ entity }) => entity));
}

/** The lower median, so an even count still lands exactly on one ask (one straight wire). */
function median(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[(sorted.length - 1) >> 1];
}
