/**
 * Vertical placement for the auto-layout: alternating sweeps over the layers, each entity asking
 * for the height that lines its socket up with the median of its neighbours' (so most wires run
 * straight), then each layer packed without overlap by isotonic regression - the placement closest
 * to every ask that keeps the layer's order and spacing. Writes each entity's `y`.
 */

import type { LayeredGraph, LayoutEntity, LayoutLink } from "./layeredGraph";

/** Right-to-left + left-to-right sweep pairs after the seeding pass. */
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

export function placeRows(layered: LayeredGraph, grid: number): void {
  const { layers, outgoing, incoming } = layered;
  const gapBetween = (upper: LayoutEntity, lower: LayoutEntity): number =>
    upper.signal !== undefined && lower.signal !== undefined ? 0 : grid;

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
      packLayer(layer, towardTargets, gapBetween, grid);
    }
  };
  const sweepRightward = (): void => {
    for (let index = layers.length - 2; index >= 0; index--) {
      const layer = layers[index];
      if (layer !== undefined) {
        packLayer(layer, towardSources, gapBetween, grid);
      }
    }
  };

  sweepLeftward();
  for (let pass = 0; pass < SWEEP_PAIRS; pass++) {
    sweepRightward();
    sweepLeftward();
  }
  untangleTradedRows(layered, grid);
}

/** Passes of {@link untangleTradedRows}: each fix can expose a trade in a neighbouring channel. */
const UNTANGLE_PASSES = 6;
/** How many cells a placeholder may be nudged to break a trade. */
const NUDGE_CELLS = [1, -1, 2, -2, 3, -3];

/**
 * Two signals that trade rows across a channel - each leaving on the row the other arrives on -
 * cannot both turn on a single lane (each would have to turn before the other). Where both rows
 * on one side are placeholders, swapping those two lets both signals run straight; otherwise a
 * placeholder among the four moves to a free cell nearby, so the rows no longer coincide.
 * Placeholders are interchangeable one-cell slots, so either keeps the packing valid.
 */
function untangleTradedRows(layered: LayeredGraph, grid: number): void {
  const { layers, links } = layered;
  const gapBetween = (upper: LayoutEntity, lower: LayoutEntity): number =>
    upper.signal !== undefined && lower.signal !== undefined ? 0 : grid;
  const fitsAt = (entity: LayoutEntity, y: number): boolean =>
    (layers[entity.layer] ?? []).every(
      (other) =>
        other === entity ||
        other.y + other.height + gapBetween(other, entity) <= y ||
        y + entity.height + gapBetween(entity, other) <= other.y,
    );
  const untangle = (first: LayoutLink, second: LayoutLink): boolean => {
    const right = [first.to.entity, second.to.entity] as const;
    const left = [first.from.entity, second.from.entity] as const;
    for (const [upper, lower] of [right, left]) {
      if (upper.signal !== undefined && lower.signal !== undefined) {
        [upper.y, lower.y] = [lower.y, upper.y];
        return true;
      }
    }
    for (const entity of [...right, ...left]) {
      if (entity.signal === undefined) {
        continue;
      }
      const target = NUDGE_CELLS.map((cells) => entity.y + cells * grid).find((y) =>
        fitsAt(entity, y),
      );
      if (target !== undefined) {
        entity.y = target;
        return true;
      }
    }
    return false;
  };

  for (let pass = 0; pass < UNTANGLE_PASSES; pass++) {
    let changed = false;
    for (let layer = layers.length - 1; layer >= 1; layer--) {
      const channel = links.filter(
        (link) => link.from.entity.layer === layer && link.to.entity.layer === layer - 1,
      );
      for (const first of channel) {
        for (const second of channel) {
          if (
            first.signal !== second.signal &&
            sourceRow(first) === targetRow(second) &&
            sourceRow(second) === targetRow(first) &&
            untangle(first, second)
          ) {
            changed = true;
          }
        }
      }
    }
    if (!changed) {
      return;
    }
  }
}

/**
 * Re-orders `layer` by where each entity asks to be (the median of `asks`, or where it is) and
 * places it as close to those asks as its order and spacing allow (pool-adjacent-violators over
 * the asks with the stacking offsets taken out), snapped to the grid.
 */
function packLayer(
  layer: LayoutEntity[],
  asks: (entity: LayoutEntity) => readonly number[],
  gapBetween: (upper: LayoutEntity, lower: LayoutEntity) => number,
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
      offset += previous.height + gapBetween(previous, entity);
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
