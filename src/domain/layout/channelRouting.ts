/**
 * Horizontal placement and wire routing for the auto-layout. Columns are left-aligned; the gap
 * between two columns is a routing channel sized to fit its wires.
 *
 * The editor draws a wire as an elbow (`ui/graph/wireRenderer.ts`'s `wirePoints`): a one-cell stub
 * out of the source dot, a straight segment, a one-cell stub into the target dot. With cards on the
 * grid that segment runs from `x + width + grid` of the source to `x - grid` of the target: level
 * when both dots share a row, upright when those two grid lines coincide, slanted otherwise. So a
 * signal that changes row in a channel turns on a vertical *lane* there, and routes (fixed-size
 * pass-through knots, same stub rule) carry it to and from that lane where a card's own stub cannot:
 * R1 on the source row, ending at the lane; one R2 per other row, starting from it.
 *
 * Per channel: try the narrowest width first; search lane choices (with backtracking, cheapest
 * first) so no two signals share a lane span, no lane runs through a route, no two routes crowd one
 * row, and on a row one signal leaves while another arrives the leaving one turns first.
 */

import type { LayeredGraph, LayoutEntity, LayoutLink, LayoutSignal } from "./layeredGraph";
import { sourceRow, targetRow } from "./rowPlacement";

/** A route's geometry as the layout needs it. */
export interface RouteGeometry {
  readonly width: number;
  /** Its dots' centre height from its top edge (both dots share the row). */
  readonly row: number;
}

/** One signal's crossing of one channel. */
export interface ChannelNet {
  readonly signal: LayoutSignal;
  /** The row it enters the channel on. */
  readonly sourceRow: number;
  readonly links: readonly LayoutLink[];
  /** Where it turns; `undefined` when every link runs straight on its source row. */
  readonly lane: number | undefined;
  /** Whether it needs a route on its source row to reach the lane. */
  readonly needsLeadRoute: boolean;
  /** The links that need a route from the lane to their row. */
  readonly trailRoutes: ReadonlySet<LayoutLink>;
}

export interface ChannelPlan {
  /** Left edge of the column right of the channel. */
  readonly right: number;
  readonly nets: readonly ChannelNet[];
}

export interface ColumnPlan {
  /** Left edge per layer (layer 0 at 0, the rest to its left). */
  readonly columnX: readonly number[];
  /** The channel left of each layer's column, by the layer to its right: `channels[layer]` runs
   *  between layer `layer` and layer `layer - 1` (index 0 unused). */
  readonly channels: readonly (ChannelPlan | undefined)[];
}

/** A channel this narrow lets a jog out of its column's widest card need no route at all. */
const MIN_CHANNEL_CELLS = 2;
/** How far a channel may widen before the turn-order rule is given up as unsatisfiable. */
const MAX_EXTRA_CELLS = 40;
/** Lane searches per channel width before trying a wider one. */
const SEARCH_BUDGET = 4000;

interface RouteBox {
  readonly row: number;
  readonly left: number;
  readonly right: number;
}

interface LaneChoice {
  readonly lane: number;
  readonly boxes: readonly RouteBox[];
  readonly needsLeadRoute: boolean;
  readonly trailRoutes: ReadonlySet<LayoutLink>;
}

interface Crossing {
  readonly signal: LayoutSignal;
  readonly source: LayoutEntity;
  readonly sourceRow: number;
  readonly links: readonly LayoutLink[];
  readonly rows: readonly number[];
  readonly top: number;
  readonly bottom: number;
}

export function planColumns(layered: LayeredGraph, grid: number, route: RouteGeometry): ColumnPlan {
  const { layers, links } = layered;
  const columnWidth = layers.map((layer) =>
    Math.max(
      route.width,
      ...layer.filter((entity) => entity.signal === undefined).map((entity) => entity.width),
    ),
  );
  const columnX: number[] = [0];
  const channels: (ChannelPlan | undefined)[] = [undefined];
  for (let layer = 1; layer < layers.length; layer++) {
    const right = columnX[layer - 1] ?? 0;
    const crossings = channelCrossings(
      links.filter(
        (link) => link.from.entity.layer === layer && link.to.entity.layer === layer - 1,
      ),
    );
    const geometry: ChannelGeometry = {
      grid,
      route,
      right,
      leftColumnWidth: columnWidth[layer] ?? route.width,
      rightColumnWidth: columnWidth[layer - 1] ?? route.width,
    };
    const { width, choices } = fitChannel(crossings, geometry);
    columnX[layer] = right - width - (columnWidth[layer] ?? route.width);
    channels[layer] = {
      right,
      nets: crossings.map((crossing) => {
        const choice = choices.get(crossing);
        return {
          signal: crossing.signal,
          sourceRow: crossing.sourceRow,
          links: crossing.links,
          lane: choice?.lane,
          needsLeadRoute: choice?.needsLeadRoute ?? false,
          trailRoutes: choice?.trailRoutes ?? new Set(),
        };
      }),
    };
  }
  return { columnX, channels };
}

function channelCrossings(links: readonly LayoutLink[]): Crossing[] {
  const bySignal = new Map<LayoutSignal, LayoutLink[]>();
  for (const link of links) {
    const group = bySignal.get(link.signal);
    if (group === undefined) {
      bySignal.set(link.signal, [link]);
    } else {
      group.push(link);
    }
  }
  return [...bySignal].flatMap(([signal, group]) => {
    const first = group[0];
    if (first === undefined) {
      return [];
    }
    const row = sourceRow(first);
    const rows = group.map(targetRow);
    return [
      {
        signal,
        source: first.from.entity,
        sourceRow: row,
        links: group,
        rows,
        top: Math.min(row, ...rows),
        bottom: Math.max(row, ...rows),
      },
    ];
  });
}

interface ChannelGeometry {
  readonly grid: number;
  readonly route: RouteGeometry;
  /** Left edge of the right column. */
  readonly right: number;
  readonly leftColumnWidth: number;
  readonly rightColumnWidth: number;
}

/** The narrowest channel that routes every turning crossing, and the lanes chosen for them. */
function fitChannel(
  crossings: readonly Crossing[],
  geometry: ChannelGeometry,
): { readonly width: number; readonly choices: ReadonlyMap<Crossing, LaneChoice> } {
  const { grid } = geometry;
  const turning = turnFirstOrder(
    crossings
      .filter((crossing) => crossing.rows.some((row) => row !== crossing.sourceRow))
      // Real sources first (only they can turn on their own stub), then short spans.
      .sort(
        (first, second) =>
          Number(first.source.signal !== undefined) - Number(second.source.signal !== undefined) ||
          first.bottom - first.top - (second.bottom - second.top) ||
          first.top - second.top,
      ),
  );
  const minimum = MIN_CHANNEL_CELLS * grid;
  for (const strictOrder of [true, false]) {
    for (
      let width = minimum;
      width <= minimum + MAX_EXTRA_CELLS * grid * (strictOrder ? 1 : 2);
      width += grid
    ) {
      const choices = assignLanes(turning, geometry, width, strictOrder);
      if (choices !== undefined) {
        return { width, choices };
      }
    }
  }
  throw new Error("Layout: a channel could not be routed");
}

/**
 * Orders turning crossings so that one leaving on a row another arrives on - which must turn
 * first, on a lane further left - comes before it: the lane search then meets each turn-order
 * rule from the side that can still satisfy it. Stable otherwise; a cycle keeps its given order.
 */
function turnFirstOrder(turning: readonly Crossing[]): Crossing[] {
  const mustPrecede = (first: Crossing, second: Crossing): boolean =>
    first !== second && second.rows.includes(first.sourceRow);
  const ordered: Crossing[] = [];
  const remaining = [...turning];
  while (remaining.length > 0) {
    const index = remaining.findIndex((candidate) =>
      remaining.every((other) => !mustPrecede(other, candidate)),
    );
    const [next] = remaining.splice(Math.max(index, 0), 1);
    if (next !== undefined) {
      ordered.push(next);
    }
  }
  return ordered;
}

/** Backtracking lane search: the fewest routes overall, within {@link SEARCH_BUDGET} steps. */
function assignLanes(
  turning: readonly Crossing[],
  geometry: ChannelGeometry,
  width: number,
  strictOrder: boolean,
): Map<Crossing, LaneChoice> | undefined {
  const { grid, right } = geometry;
  const left = right - width;
  const candidates = turning.map((crossing) => {
    const options: LaneChoice[] = [];
    for (let lane = right - grid; lane >= left + grid; lane -= grid) {
      const choice = laneChoice(crossing, lane, left, geometry);
      if (choice !== undefined) {
        options.push(choice);
      }
    }
    // Equal cost: a crossing others must turn after takes the leftmost lane, leaving them room.
    const leadsOthers = turning.some(
      (other) => other !== crossing && other.rows.includes(crossing.sourceRow),
    );
    return options.sort(
      (first, second) =>
        first.boxes.length - second.boxes.length ||
        (leadsOthers ? first.lane - second.lane : second.lane - first.lane),
    );
  });

  const placed: { readonly crossing: Crossing; readonly choice: LaneChoice }[] = [];
  let best: Map<Crossing, LaneChoice> | undefined;
  let bestCost = Infinity;
  let budget = SEARCH_BUDGET;
  const search = (index: number, cost: number): void => {
    if (cost >= bestCost || budget-- <= 0) {
      return;
    }
    const crossing = turning[index];
    if (crossing === undefined) {
      best = new Map(placed.map((entry) => [entry.crossing, entry.choice]));
      bestCost = cost;
      return;
    }
    for (const choice of candidates[index] ?? []) {
      if (
        placed.some((other) =>
          clashes(crossing, choice, other.crossing, other.choice, grid, strictOrder),
        )
      ) {
        continue;
      }
      placed.push({ crossing, choice });
      search(index + 1, cost + choice.boxes.length);
      placed.pop();
      if (budget <= 0) {
        return;
      }
    }
  };
  search(0, 0);
  return best;
}

/**
 * What turning on `lane` costs a crossing: the routes it needs, or `undefined` when one would not
 * fit. A route keeps a cell clear of the card beside it; a route standing in a dummy's slot keeps
 * clear of the previous channel's route in that slot.
 */
function laneChoice(
  crossing: Crossing,
  lane: number,
  left: number,
  geometry: ChannelGeometry,
): LaneChoice | undefined {
  const { grid, route, right, leftColumnWidth } = geometry;
  const columnLeft = left - leftColumnWidth;
  const source = crossing.source;
  const boxes: RouteBox[] = [];
  const sourceIsCard = source.signal === undefined;
  const needsLeadRoute = !sourceIsCard || lane !== columnLeft + source.width + grid;
  if (needsLeadRoute) {
    const boxLeft = lane - grid - route.width; // its out-stub lands on the lane
    const floor = sourceIsCard ? columnLeft + source.width + grid : columnLeft + route.width + grid;
    if (boxLeft < floor) {
      return undefined;
    }
    boxes.push({ row: crossing.sourceRow, left: boxLeft, right: boxLeft + route.width });
  }
  const trailRoutes = new Set<LayoutLink>();
  for (const link of crossing.links) {
    const row = targetRow(link);
    if (row === crossing.sourceRow) {
      continue;
    }
    const targetIsCard = link.to.entity.signal === undefined;
    if (targetIsCard && lane === right - grid) {
      continue; // the target's own in-stub is the lane
    }
    const boxLeft = lane + grid;
    const ceiling = targetIsCard ? right - grid : right + route.width;
    if (boxLeft + route.width > ceiling) {
      return undefined;
    }
    boxes.push({ row, left: boxLeft, right: boxLeft + route.width });
    trailRoutes.add(link);
  }
  return { lane, boxes, needsLeadRoute, trailRoutes };
}

function clashes(
  crossing: Crossing,
  choice: LaneChoice,
  other: Crossing,
  otherChoice: LaneChoice,
  grid: number,
  strictOrder: boolean,
): boolean {
  if (
    choice.lane === otherChoice.lane &&
    !(crossing.bottom + grid <= other.top || other.bottom + grid <= crossing.top)
  ) {
    return true; // overlapping spans on one lane
  }
  const laneThrough = (lane: number, span: Crossing, boxes: readonly RouteBox[]): boolean =>
    boxes.some(
      (box) =>
        box.row > span.top - grid &&
        box.row < span.bottom + grid &&
        lane >= box.left - grid / 2 &&
        lane <= box.right + grid / 2,
    );
  if (
    laneThrough(choice.lane, crossing, otherChoice.boxes) ||
    laneThrough(otherChoice.lane, other, choice.boxes)
  ) {
    return true;
  }
  const crowded = choice.boxes.some((box) =>
    otherChoice.boxes.some(
      (otherBox) =>
        box.row === otherBox.row &&
        box.left < otherBox.right + grid &&
        otherBox.left < box.right + grid,
    ),
  );
  if (crowded) {
    return true;
  }
  if (!strictOrder) {
    return false;
  }
  // On a row one leaves and the other arrives, the leaving one must turn first.
  if (other.rows.includes(crossing.sourceRow) && !(choice.lane < otherChoice.lane)) {
    return true;
  }
  return crossing.rows.includes(other.sourceRow) && !(otherChoice.lane < choice.lane);
}
