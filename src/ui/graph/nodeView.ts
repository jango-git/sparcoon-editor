/**
 * One node rendered as a DOM card: a title, its input/output socket rows, and inline
 * parameter widgets driven by the node's `describe().params` metadata (parameters are edited on the
 * node, always visible - no inspector panel).
 *
 * Each widget dispatches an `onParamChange(key, value)` on edit; the graph canvas wires
 * that to the `updateNodeParam` command. Widget pointer events are stopped from bubbling
 * so editing a field never starts a node drag or selection. On an external change (undo /
 * redo) {@link update} re-syncs each widget from the node's params, skipping a field the
 * user is actively editing.
 */

import type { AttributeTypeName, GraphNode } from "../../domain/graphModel";
import type { FXNodeMeta, FXParamMeta, FXSocketMeta } from "../../domain/nodePalette";
import { humanizeKey, attributeNameFromSlot } from "../../domain/nodePalette";
import { createElement } from "../dom";
import { t } from "../../i18n";
import { nodeDescription, nodeLabel, nodeParamLabel, nodeSocketLabel } from "../../i18n/nodeText";
import { clamp } from "../primitives/math";
import { GRID_SIZE } from "./grid";
import {
  COL_CENTER,
  COL_END,
  COL_IN_DOT,
  COL_IN_LABEL,
  COL_OUT_DOT,
  COL_OUT_LABEL,
  MAX_NODE_CELLS,
  MIN_NODE_CELLS,
  NODE_WIDTH_CLIP_GUARD,
  centerCell,
  mountBody,
  type Cell,
  type NodeRow,
} from "./nodeGrid";
import { buildHelpIcon } from "./nodeHelpIcon";
import { attachTooltip } from "../components/tooltip";
import {
  buildAttributeRow,
  buildAttributeName,
  buildAttributeRemove,
  buildAttributeType,
  type AttributeNodeConfig,
} from "./nodeAttributeRow";
import { buildTextureAssetRows, type TextureAssetOption } from "./nodeTextureRow";
import type { PaletteAccess } from "../components/colorPicker";
import { NodeWidgets } from "./nodeWidgets";
import { socketTypeColor } from "./socketColors";

export type { AttributeNodeConfig, AttributeOption } from "./nodeAttributeRow";
export type { TextureAssetOption } from "./nodeTextureRow";

export type ParamChangeHandler = (key: string, value: unknown) => void;

/** Which end of an edge a socket is: an output source (right) or input target (left). */
export type SocketSide = "input" | "output";

/** Identifies one socket on one placed node, with its carried type (for compatibility). */
export interface SocketRef {
  readonly nodeId: string;
  readonly socketKey: string;
  readonly side: SocketSide;
  /** GLSL type name, or `"T"` for a generic socket. */
  readonly type: string;
}

/** Starts a wire drag from a socket dot (the canvas turns it into a connection/binding). */
export type SocketPointerHandler = (event: PointerEvent, socket: SocketRef) => void;

/**
 * Params of an attribute node the editor does not surface: `type` is derived from the chosen
 * attribute, and `stage`/`phase` are placement - inferred, not user-set.
 */
const ATTRIBUTE_NODE_HIDDEN_PARAMS: ReadonlySet<string> = new Set(["type", "stage", "phase"]);

/** Shared empty set for the default (no connected inputs) case, to avoid per-view allocation. */
const NO_CONNECTED_INPUTS: ReadonlySet<string> = new Set();

/** The header cost badge's display text - whole numbers, matching the Stats panel's formatting. */
function formatCost(cost: number): string {
  return Math.round(cost).toLocaleString("en-US");
}

/** Grid rows a gradient (color-ramp) block occupies: a label + preview bar + stop editor. */
const GRADIENT_ROW_SPAN = 4;

/**
 * Grid rows a curve block occupies. Taller than a gradient: a label + the ~96px SVG plot + two
 * stacked settings rows (the selected-anchor editor and the value-range fields) + gaps, ~183px.
 * Sized (rows x 24px) to comfortably clear the content so the block never overflows its cell.
 */
const CURVE_ROW_SPAN = 8;

export class NodeView {
  public readonly element: HTMLElement;
  /** Socket dot elements, keyed `${side}:${key}`, for wire endpoint measurement. */
  private readonly socketDots = new Map<string, HTMLElement>();
  /** Builds, syncs and disposes the card's value controls (params + editable input sockets). */
  private readonly widgets: NodeWidgets;
  /** The header cost badge's value box, present when the node has a real engine cost or (for a
   *  sink) its own graph's reachable-cost total. */
  private readonly costValue: HTMLElement | undefined;
  /** The node's stable type - the i18n lookup key for its label/description/socket/param text
   *  (see `i18n/nodeText.ts`), never displayed itself. */
  private readonly nodeType: string;

  constructor(
    node: GraphNode,
    metadata: FXNodeMeta | undefined,
    private readonly onParamChange?: ParamChangeHandler,
    // Fires on every intermediate step of a scrub/drag control (a live preview, no history entry);
    // omitted entirely for a behavior-graph node, whose params then report nothing until release
    // (see graphCanvas.ts's wiring and NodeWidgets' matching `live` channel).
    onLiveParamChange?: ParamChangeHandler,
    attribute?: AttributeNodeConfig,
    onSocketPointerDown?: SocketPointerHandler,
    connectedInputs: ReadonlySet<string> = NO_CONNECTED_INPUTS,
    textureAssets: readonly TextureAssetOption[] = [],
    onRemoveAttribute?: (name: string) => void,
    onSetAttributeType?: (name: string, type: AttributeTypeName) => void,
    onRenameAttribute?: (oldName: string, newName: string) => boolean,
    // Live cost at construction time (see `update`'s `cost` parameter for how it stays current).
    // `undefined` when the node has no engine-computed cost (a sink) - the badge is then omitted.
    cost?: number,
    // A sink's own graph reachable-cost total (domain/graphStats.ts's `computeSinkCost`), shown in
    // the same badge in place of `cost` - a sink has no per-node engine cost of its own, but its
    // header is where that graph's total now lives (moved off the Stats panel, which sums the
    // whole effect instead). `undefined` for every non-sink node.
    sinkCost?: number,
    // Forwarded to every color-flagged field's picker/ramp (see NodeWidgets' matching param).
    paletteAccess?: PaletteAccess,
    // Live graph zoom (graphCanvas.ts's `() => this.viewport.scale`), forwarded to every dropdown
    // this card builds so a popup's rows visually match the zoomed trigger they hang from.
    scale?: () => number,
  ) {
    this.nodeType = node.type;
    this.widgets = new NodeWidgets(
      metadata,
      onParamChange,
      onLiveParamChange,
      paletteAccess,
      scale,
    );
    const allParameters = metadata === undefined ? [] : Object.entries(metadata.params);
    // A free-text parameter name (a named uniform/binding slot), rendered as a body text field.
    const paramNameKey = metadata?.customParams?.find(
      (customParam) => customParam.kind === "param-name",
    )?.key;
    // An attribute node (`custom-attribute`(-components)) is driven by an attribute picker;
    // its type and placement are derived, so those params are hidden.
    const isAttributeNode =
      metadata?.customParams?.some((customParam) => customParam.kind === "attribute-name") ?? false;
    // `constant` is a pure inline-literal source - it never takes an input wire, so its
    // socket dots are hidden (only the editable value fields show; the connect affordance
    // would be noise). Its value still renders as an editable row below.
    const hideInputSockets = metadata?.type === "constant";
    const paramEntries = allParameters.filter(
      ([key]) => !(isAttributeNode && ATTRIBUTE_NODE_HIDDEN_PARAMS.has(key)),
    );
    const allInputs = metadata?.inputs ?? [];

    const label = nodeLabel(this.nodeType) ?? node.type;
    const titleChildren: HTMLElement[] = [
      createElement("span", { className: "node__title-text", textContent: label }),
    ];
    // The node's live complexity/cost (domain/graphStats.ts), a small value box left of the help
    // icon - mirrors the Stats panel's value boxes. Omitted (not a "0") when the node has no
    // engine-computed cost at all (a sink), which `metadata.cost` being absent signals - a sink
    // gets the same badge instead from `sinkCost`, its own graph's reachable-cost total.
    if (metadata?.cost !== undefined) {
      this.costValue = createElement("span", {
        className: "node__cost",
        textContent: formatCost(cost ?? metadata.cost),
      });
      attachTooltip(this.costValue, t("stats.cost"), t("stats.costTip"));
      titleChildren.push(this.costValue);
    } else if (sinkCost !== undefined) {
      this.costValue = createElement("span", {
        className: "node__cost",
        textContent: formatCost(sinkCost),
      });
      attachTooltip(this.costValue, t("stats.graphCost"), t("stats.graphCostTip"));
      titleChildren.push(this.costValue);
    }
    // A help "?" at the far right of the header shows the node's documentation in the shared hover
    // tooltip. Skipped when the node has no description.
    const description = nodeDescription(this.nodeType, { domain: metadata?.domain })?.trim() ?? "";
    if (description !== "") {
      titleChildren.push(buildHelpIcon(label, description));
    }
    const title = createElement("div", { className: "node__title" }, titleChildren);

    const bodyRows: NodeRow[] = [];

    // Socket rows: each input on the left (dot / name / inline default) is paired by row
    // index with an output on the right, yielding a combined
    // `[in][name][default] ... [out name][out]` row wherever both exist. `constant` hides its
    // input dots, leaving just the full-width value editor. An unconnected input shows its
    // value editor inline; it collapses once a wire lands (the canvas rebuilds this view).
    const outputCells = (metadata?.outputs ?? []).map((socket) => ({
      label: this.buildLabel(socket, "output"),
      dot: this.buildDot(node.id, socket, "output", onSocketPointerDown),
    }));
    const inputRows = allInputs.map((socket): Cell[] => {
      const cells: Cell[] = [];
      // A behavior sink's declared attributes are input rows keyed `attr:<name>`; the whole
      // attribute lives on its input row - never mirrored in a separate list below. Only Spawn's
      // caller passes `onRemoveAttribute`, so only there does the row also carry a rename field
      // (in place of the plain label), a type picker, and a remove button in the (unused, sinks
      // have no outputs) right lane - Update's row stays a plain, wireable input with its
      // ordinary label.
      const attributeName =
        onRemoveAttribute !== undefined ? attributeNameFromSlot(socket.key) : undefined;
      if (!hideInputSockets) {
        cells.push({
          element: this.buildDot(node.id, socket, "input", onSocketPointerDown),
          col: COL_IN_DOT,
        });
        cells.push({
          element:
            attributeName !== undefined && onRenameAttribute !== undefined
              ? buildAttributeName(attributeName, onRenameAttribute)
              : this.buildLabel(socket, "input"),
          col: COL_IN_LABEL,
        });
      }
      if (socket.control !== undefined && !connectedInputs.has(socket.key)) {
        const control = centerCell(this.widgets.createSocketControl(node, socket));
        // With a dot shown the editor sits in the centre lane; a dot-less `constant` editor
        // stretches across the input+centre lanes. Either way it stops before the output
        // lanes so it never overlaps a paired output on the same row.
        cells.push(
          hideInputSockets
            ? { element: control, col: COL_IN_DOT, colEnd: COL_OUT_LABEL }
            : { element: control, col: COL_CENTER },
        );
      }
      if (attributeName !== undefined) {
        if (onSetAttributeType !== undefined) {
          const typePicker = buildAttributeType(
            attributeName,
            socket.type,
            onSetAttributeType,
            scale,
          );
          cells.push({ element: typePicker, col: COL_CENTER });
        }
        if (onRemoveAttribute !== undefined) {
          const remove = buildAttributeRemove(attributeName, onRemoveAttribute);
          cells.push({ element: remove, col: COL_OUT_LABEL, colEnd: COL_END });
        }
      }
      return cells;
    });
    const socketRowCount = Math.max(inputRows.length, outputCells.length);
    for (let index = 0; index < socketRowCount; index += 1) {
      const cells: Cell[] = [...(inputRows[index] ?? [])];
      const outputCell = outputCells[index];
      if (outputCell !== undefined) {
        cells.push({ element: outputCell.label, col: COL_OUT_LABEL });
        cells.push({ element: outputCell.dot, col: COL_OUT_DOT });
      }
      bodyRows.push({ cells });
    }

    // Body params below the sockets: the parameter name field, the attribute picker, then the
    // ordinary parameter widgets - each `[label][control]`, aligned to the same columns.
    if (paramNameKey !== undefined) {
      // A Texture picks a raster asset from the library (a dropdown of uploaded
      // textures); a Timeline Value keeps a free-text name for its uniform/binding slot.
      if (metadata?.type === "texture") {
        bodyRows.push(
          ...buildTextureAssetRows(node, paramNameKey, textureAssets, {
            widgets: this.widgets,
            onParamChange: this.onParamChange,
            labelledRow: (label, control) => this.labelledRow(label, control),
            scale,
          }),
        );
      } else {
        bodyRows.push(this.paramNameRow(node, paramNameKey));
      }
    }
    if (isAttributeNode && attribute !== undefined) {
      bodyRows.push(
        buildAttributeRow(
          node,
          attribute,
          this.widgets,
          (label, control) => this.labelledRow(label, control),
          scale,
        ),
      );
    }
    for (const [key, parameter] of paramEntries) {
      bodyRows.push(this.paramRow(node, key, parameter));
    }

    const body = mountBody(bodyRows);
    this.element = createElement("div", { className: "node" }, [title, body]);

    // Height falls out of the flex column: the title cell plus the grid's rows, each a whole
    // grid cell tall, so the box stays grid-aligned. Width is content-sized in
    // {@link finalizeSize} once the card is in the DOM and can be measured.
    this.update(node, false);
  }

  /**
   * Sizes the card to its content and snaps the width up to a whole number of grid cells.
   * Must run after the element is in the DOM (it measures `offsetWidth`); the canvas calls it
   * right after mounting the node. The first paint can measure with fallback-font metrics (the
   * web font loads async), so it re-snaps once fonts are ready - guarded for environments
   * (tests) without the Font Loading API.
   */
  public finalizeSize(): void {
    this.snapWidth();
    const fonts = document.fonts as FontFaceSet | undefined;
    if (fonts !== undefined) {
      fonts.ready.then(() => this.snapWidth()).catch(() => {});
    }
  }

  /** Releases every child widget (closing any open popover) when this view is dropped. */
  public dispose(): void {
    this.widgets.dispose();
  }

  /**
   * Re-syncs the card from the current model. `cost` is this node's freshly recomputed live
   * price (see `domain/graphStats.ts`'s `computeNodeCosts`, called once per canvas render and
   * threaded in per node); `sinkCost` is the same thing for a sink's own graph total
   * (`computeSinkCost`). Both are `undefined` when they don't apply to this node, matching the
   * constructor's badge-presence check (a node either always shows a badge or never does; only
   * its number moves).
   */
  public update(node: GraphNode, selected: boolean, cost?: number, sinkCost?: number): void {
    this.setPosition(node.position.x, node.position.y);
    this.element.classList.toggle("node--selected", selected);
    this.widgets.sync(node);
    if (this.costValue !== undefined) {
      if (cost !== undefined) {
        this.costValue.textContent = formatCost(cost);
      } else if (sinkCost !== undefined) {
        this.costValue.textContent = formatCost(sinkCost);
      }
    }
  }

  public setPosition(x: number, y: number): void {
    this.element.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** The socket dot element for one port, used by the canvas to place a wire's endpoint. */
  public socketDot(side: SocketSide, key: string): HTMLElement | undefined {
    return this.socketDots.get(`${side}:${key}`);
  }

  /**
   * Paints each socket dot filled (accent) when it carries an edge. `filledKeys` holds the
   * connected ports as `${side}:${socketKey}`; the canvas recomputes it from the graph's
   * connections and bindings on every render.
   */
  public applySocketFills(filledKeys: ReadonlySet<string>): void {
    for (const [key, dot] of this.socketDots) {
      dot.classList.toggle("socket__dot--filled", filledKeys.has(key));
    }
  }

  /**
   * Measures the natural (content) width under `max-content` and pins the card to the next
   * whole number of grid cells, clamped to `[MIN_NODE_CELLS, MAX_NODE_CELLS]`. A zero measure
   * (an inactive/hidden panel, or a detached card) is left on the CSS `max-content` fallback
   * so a bad size is never committed; a later call re-snaps once the card can be measured.
   */
  private snapWidth(): void {
    this.element.style.width = "max-content";
    const natural = this.element.offsetWidth;
    if (natural === 0) {
      return;
    }
    const cells = clamp(
      Math.ceil((natural + NODE_WIDTH_CLIP_GUARD) / GRID_SIZE),
      MIN_NODE_CELLS,
      MAX_NODE_CELLS,
    );
    this.element.style.width = `${cells * GRID_SIZE}px`;
  }

  /**
   * A socket's connection dot - its own grid cell and the wire's drag handle: pressing it
   * starts a wire (stopping the node-drag gesture), and it carries the socket's identity as
   * data attributes so the canvas can hit-test a drop with `elementFromPoint`.
   */
  private buildDot(
    nodeId: string,
    socket: FXSocketMeta,
    side: SocketSide,
    onSocketPointerDown?: SocketPointerHandler,
  ): HTMLElement {
    const dot = createElement("span", { className: `socket__dot socket__dot--${side}` });
    const ref: SocketRef = { nodeId, socketKey: socket.key, side, type: socket.type };
    dot.dataset["node"] = nodeId;
    dot.dataset["socket"] = socket.key;
    dot.dataset["side"] = side;
    dot.dataset["type"] = socket.type;
    // Tint the dot (and, via the wire layer, its edges) by the data type it carries.
    dot.style.setProperty("--socket-color", socketTypeColor(socket.type));
    if (onSocketPointerDown !== undefined) {
      dot.addEventListener("pointerdown", (event) => onSocketPointerDown(event, ref));
    }
    this.socketDots.set(`${side}:${socket.key}`, dot);
    return dot;
  }

  /** A socket's name label - its own grid cell (right-aligned for outputs). */
  private buildLabel(socket: FXSocketMeta, side: SocketSide): HTMLElement {
    const socketSide = side === "output" ? "outputs" : "inputs";
    const text =
      socket.label ??
      nodeSocketLabel(this.nodeType, socketSide, socket.key) ??
      humanizeKey(socket.key);
    return createElement("span", {
      className: side === "output" ? "socket__label socket__label--out" : "socket__label",
      textContent: text,
    });
  }

  private paramRow(node: GraphNode, key: string, parameter: FXParamMeta): NodeRow {
    const label = createElement("span", {
      className: "param__label",
      textContent: nodeParamLabel(this.nodeType, key) ?? humanizeKey(key),
    });
    const control = this.widgets.createParamControl(node, key, parameter);
    // A gradient (color-ramp) or curve editor is a tall widget: stack it under its label as a
    // full-width block spanning several grid rows rather than squeezing it into a field row.
    if (
      parameter.kind === "structural" &&
      (parameter.type === "gradient" || parameter.type === "curve")
    ) {
      const block = createElement("div", { className: "param param--block" }, [label, control]);
      block.addEventListener("pointerdown", (event) => event.stopPropagation());
      const span = parameter.type === "curve" ? CURVE_ROW_SPAN : GRADIENT_ROW_SPAN;
      return { cells: [{ element: block, col: COL_IN_DOT, colEnd: COL_END }], span };
    }
    return this.labelledRow(label, control);
  }

  /**
   * A body parameter row: its label in the input-label column (aligned with the socket names, and
   * leaving the dot column to size on dots alone) and its control filling the centre-to-right
   * lanes.
   */
  private labelledRow(label: HTMLElement, control: HTMLElement): NodeRow {
    return {
      cells: [
        { element: label, col: COL_IN_LABEL },
        { element: centerCell(control), col: COL_CENTER, colEnd: COL_END },
      ],
    };
  }

  /** The free-text Name field for a parameter node - its stable uniform/binding slot. */
  private paramNameRow(node: GraphNode, key: string): NodeRow {
    const label = createElement("span", {
      className: "param__label",
      textContent: t("graph.paramName"),
    });
    const input = document.createElement("input");
    input.type = "text";
    input.className = "param__input";
    input.placeholder = t("graph.paramNamePlaceholder");
    input.value = String(node.parameters[key] ?? "");
    // Commit on change (blur / Enter), not per keystroke: the name is the uniform/binding
    // slot, so committing recompiles - debouncing to blur avoids a recompile per character.
    input.addEventListener("change", () => this.onParamChange?.(key, input.value.trim()));
    this.widgets.registerSyncer(key, (value) => {
      if (document.activeElement !== input) {
        input.value = String(value ?? "");
      }
    });
    return this.labelledRow(label, input);
  }
}
