/**
 * The interactive node editor mounted into the graph region. It renders the active graph's nodes
 * from source and turns input into commands:
 *
 * - right-click -> add-node menu -> `addCatalogNode`
 * - drag empty space -> pan; wheel -> zoom
 * - drag a node -> `moveNodes` on release (the whole gesture is one history step)
 * - click -> select; Delete -> `removeNode`
 * - drag a socket dot -> a connection (node->node) or output binding (node->sink);
 *   grabbing a connected input detaches its edge to re-route or delete it
 *
 * Nodes are reconciled by id (not rebuilt) on every source change, so an unrelated edit or an undo
 * never destroys the node you are dragging. Edges are drawn on an in-content SVG layer
 * ({@link redrawWires}) that pans/zooms with the nodes.
 */

import type {
  AttributeTypeName,
  EditorGraph,
  GraphNode,
  GraphPosition,
  GraphSocketReference,
} from "../../domain/graphModel";
import { incomingConnection, isKeyframeValue } from "../../domain/graphModel";
import {
  GraphKind,
  READABLE_BUILTINS,
  RENDER_SINK_ID,
  RENDER_SINK_TYPE,
  ROUTE_TYPE,
  SPAWN_SINK_ID,
  SPAWN_SINK_TYPE,
  UPDATE_SINK_ID,
  UPDATE_SINK_TYPE,
  isMeshExcludedRenderNode,
  isTimelineValueType,
  isFakeNodeType,
  isSinkType,
  metaForNode,
  paletteForKind,
  searchTagsFor,
  sinkPhase,
} from "../../domain/nodePalette";
import type { FXNodeMeta, FXSocketMeta, RenderHost } from "../../domain/nodePalette";
import { isSink } from "../../domain/sinks";
import { computeNodeCosts, computeSinkCost } from "../../domain/graphStats";
import {
  addAttribute,
  addCatalogNode,
  addConnection,
  addOutputBinding,
  dissolveRoute,
  moveCommentGroup,
  moveNodes,
  nextIdentifier,
  pasteFragment,
  type GraphFragment,
  removeAttribute,
  removeComment,
  removeConnection,
  removeEdgesFromOutput,
  removeNode,
  removeOutputBinding,
  renameComment,
  replaceNodeParams,
  setAttributeType,
  setKeyframe,
  updateNodeParam,
  type GraphSlot,
} from "../../model/commands";
import { buildSinkAttributes } from "./sinkAttributes";
import {
  selectActiveGraphOwner,
  selectBehaviorGraph,
  selectBehaviorStatus,
  selectMeshAssets,
  selectRenderStatus,
  selectTextureAssets,
} from "../../model/selectors";
import { emitterEntity, vfxMeshEntity } from "../../model/entity";
import type { Store } from "../../model/store";
import type { TransportStore } from "../../model/transport";
import { createElement } from "../dom";
import { nodeDescription, nodeLabel, nodeSearchTags } from "../../i18n/nodeText";
import { beginPointerDrag } from "../primitives/drag";
import { WheelDirectionLock } from "../primitives/wheelDirectionLock";
import { EditorPanel } from "../focus/panelFocus";
import type { Keymap } from "../focus/keymap";
import { GraphMode, type GraphViewState } from "../graphViewState";
import { InputMode, type InputModeState } from "../inputMode";
import type { EditorContext } from "../editorContext";
import { createPaletteAccess } from "../components/paletteAccess";
import { AddNodeMenu } from "./addNodeMenu";
import { snapToGrid } from "./grid";
import { GraphViewport, type GraphPoint, type GraphRect } from "./graphViewport";
import { GraphCamera } from "./graphCamera";
import {
  NodeView,
  type AttributeNodeConfig,
  type SocketRef,
  type TextureAssetOption,
} from "./nodeView";
import { RouteView } from "./routeView";
import { CommentView } from "./commentView";
import {
  carriedTypeForRoute,
  resolveNodeMeta,
  resolveSocketCarriedType,
  socketShapeSignature,
} from "./typeResolution";
import {
  acceptedGenericTypesForMeta,
  inputAcceptsSource,
  socketsCompatible,
  type AcceptedTypes,
} from "./socketCompat";
import { WireRenderer, type PendingWire } from "./wireRenderer";
import { collectEdges, computeSocketFills, edgeNearPoint, type GraphEdge } from "./wireHitTest";
import { GraphKnife, type KnifeContext } from "./graphKnife";
import { GraphMarquee } from "./graphMarquee";
import { CommentGestures } from "./commentGestures";
import { applyErrorHighlights as paintErrorHighlights } from "./graphErrorHighlights";

const SVG_NS = "http://www.w3.org/2000/svg";

const DRAG_THRESHOLD = 3;

/**
 * Right-drag (pan) deadzone: a click that wobbles less than this many pixels before release
 * still counts as a plain right-click (opening the add-node menu) rather than starting a pan,
 * so a small twitch while clicking never scrolls the graph.
 */
const PAN_DEADZONE = 8;

/** How near (screen px) a click/knife-stroke must pass a wire to count as touching it. */
const WIRE_HIT_TOLERANCE = 6;

/**
 * The input socket keys carrying a wire, extracted from a node's `${side}:${key}` fill set
 * (see {@link GraphCanvas.computeSocketFills}). The node view uses this to collapse the
 * inline value editor of any editable input that is connected.
 */
function connectedInputKeys(fill: ReadonlySet<string> | undefined): ReadonlySet<string> {
  const keys = new Set<string>();
  if (fill !== undefined) {
    for (const entry of fill) {
      if (entry.startsWith("input:")) {
        keys.add(entry.slice("input:".length));
      }
    }
  }
  return keys;
}

export class GraphCanvas {
  private readonly content: HTMLElement;
  /** In-content SVG layer (graph coordinates) that draws every edge behind the nodes. */
  private readonly wires: SVGSVGElement;
  /** Screen-space rubber-band rectangle shown while marquee-selecting (left-drag). */
  private readonly marquee: HTMLElement;
  /** Screen-space SVG overlay drawing the knife stroke while Alt-dragging to cut wires. */
  private readonly knife: SVGSVGElement;
  private readonly viewport: GraphViewport;
  private readonly menu = new AddNodeMenu();
  private readonly nodeViews = new Map<string, NodeView>();
  /** Route (reroute knot) views, keyed by their node id (routes live in `graph.nodes`). */
  private readonly routeViews = new Map<string, RouteView>();
  /** Comment-box views, keyed by comment id; rendered on {@link commentLayer} behind the nodes. */
  private readonly commentViews = new Map<string, CommentView>();
  /** The back layer (behind wires and nodes) that holds the comment boxes. */
  private readonly commentLayer: HTMLElement;
  /** Per-view socket-shape signature; a change (render sink material) forces a rebuild. */
  private readonly shapeKeys = new Map<string, string>();
  /** Selected node/route ids and selected comment ids (comments never overlap node ids). */
  private readonly selected = new Set<string>();
  private readonly selectedComments = new Set<string>();
  /**
   * Copied fragment (nodes/routes + internal edges + comments), tagged with its source graph and
   * its group AABB centre (in copy-time coords) so a paste can land that centre under the cursor.
   */
  private clipboard:
    (GraphFragment & { readonly slot: GraphSlot; readonly center: GraphPoint }) | undefined;
  /** Last pointer position over the canvas (client coords), so paste/"c" land under the cursor. */
  private lastPointer: { x: number; y: number } | undefined;
  /** The graph owner (emitter or mesh) whose graph is currently shown, as `kind:id`; a change
   *  clears cross-owner selection. */
  private activeOwnerKey: string | undefined = undefined;
  /** The wire being dragged: a fixed `anchor` socket and the cursor in graph coords. */
  private pending: PendingWire | undefined;

  private readonly store: Store;
  private readonly transport: TransportStore;
  private readonly inputMode: InputModeState;
  private readonly wireRenderer: WireRenderer;
  /** Per-graph camera memory (pan/zoom per emitter+mode) and deferred frame-to-fit. */
  private readonly camera: GraphCamera;
  /** The Alt-drag knife / route-insert gesture (owns the knife overlay). */
  private readonly knifeGesture: GraphKnife;
  /** The left-drag rubber-band selection gesture (owns the marquee overlay). */
  private readonly marqueeGesture: GraphMarquee;
  /** The comment-box header-drag / resize / create gestures. */
  private readonly commentGestures: CommentGestures;
  /** Guards mouse-wheel zoom against a spurious single-notch direction flip (mouse mode only). */
  private readonly wheelDirection = new WheelDirectionLock();

  constructor(
    private readonly root: HTMLElement,
    context: EditorContext,
    private readonly graphView: GraphViewState,
  ) {
    this.store = context.store;
    this.transport = context.transport;
    this.inputMode = context.inputMode;
    const { signals, router } = context;
    this.content = createElement("div", { className: "graph__content" });
    // The comment layer sits at the bottom of the content stack - behind the wires and the
    // nodes - so comment boxes read as a background annotation the graph is drawn over.
    this.commentLayer = createElement("div", { className: "graph__comments" });
    this.content.append(this.commentLayer);
    this.wires = document.createElementNS(SVG_NS, "svg");
    this.wires.setAttribute("class", "graph__wires");
    this.content.append(this.wires);
    this.marquee = createElement("div", { className: "graph__marquee" });
    this.marquee.style.display = "none";
    this.knife = document.createElementNS(SVG_NS, "svg");
    this.knife.setAttribute("class", "graph__knife");
    this.knife.style.display = "none";
    this.root.append(this.content, this.marquee, this.knife);
    this.viewport = new GraphViewport(this.content, this.root);
    this.wireRenderer = new WireRenderer(
      this.wires,
      (nodeId, socketKey, side) => this.socketCenter(nodeId, socketKey, side),
      (binding) => this.sinkNodeId(binding),
    );
    this.camera = new GraphCamera(this.root, () => this.frameGraph());
    const knifeContext: KnifeContext = {
      knife: this.knife,
      root: this.root,
      store: this.store,
      activeSlot: () => this.activeSlot(),
      graphPoint: (clientX, clientY) => this.graphPoint(clientX, clientY),
      edgeNearPoint: (point) => this.edgeNearPoint(point),
      collectEdges: () => this.collectEdges(),
    };
    this.knifeGesture = new GraphKnife(knifeContext);
    this.marqueeGesture = new GraphMarquee({
      marquee: this.marquee,
      root: this.root,
      nodeViews: this.nodeViews,
      routeViews: this.routeViews,
      commentViews: this.commentViews,
      selected: this.selected,
      selectedComments: this.selectedComments,
      refreshSelection: (): void => this.refreshSelection(),
    });
    this.commentGestures = new CommentGestures({
      store: this.store,
      activeSlot: (): GraphSlot => this.activeSlot(),
      activeGraph: (): EditorGraph => this.activeGraph(),
      root: this.root,
      scale: (): number => this.viewport.scale,
      nodeViews: this.nodeViews,
      routeViews: this.routeViews,
      commentViews: this.commentViews,
      selected: this.selected,
      selectedComments: this.selectedComments,
      refreshSelection: (): void => this.refreshSelection(),
      redrawWires: (): void => this.redrawWires(),
      boundsOf: (nodeIds, commentIds): GraphRect | undefined => this.boundsOf(nodeIds, commentIds),
    });

    // A right-click opens the add-node menu; right-drag pans (see onBackgroundPointerDown). The
    // browser's native context menu is suppressed app-wide in the composition root (main.ts).
    this.root.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.root.addEventListener("pointerdown", (event) => this.onBackgroundPointerDown(event));
    // Track the cursor so a keyboard paste / comment-wrap places its result under the pointer.
    this.root.addEventListener("pointermove", (event) => {
      this.lastPointer = { x: event.clientX, y: event.clientY };
    });
    // Editing shortcuts fire only while the graph is the active panel; the router applies this
    // keymap then, and shares the editable-target guard (a focused field owns its keystrokes).
    router.registerPanel(EditorPanel.Graph, this.keymap());

    // Socket centres are measured from the live DOM, which reads 0x0 until the panel has
    // laid out (e.g. right after a reload, or while the graph tab is first shown). Redraw
    // the wires whenever the canvas resizes so a fresh load never leaves them collapsed at
    // the origin.
    new ResizeObserver(() => {
      this.redrawWires();
      // A first non-zero layout (fresh load, or the graph tab becoming visible) is when a
      // pending "frame on open" can finally measure the nodes and fit them.
      this.camera.maybeFrame();
    }).observe(this.root);

    signals.on("sourceStructureChanged", () => this.render());
    signals.on("sourceViewChanged", () => this.render());
    // A recompute may flip nodes in/out of the compiler's error set without any structural
    // change (e.g. the *other* graph was fixed), so repaint the highlights on every derive.
    signals.on("derivedChanged", () => this.applyErrorHighlights());
    this.graphView.onChange(() => {
      this.selected.clear();
      this.selectedComments.clear();
      this.render();
    });

    this.render();
    // A node card's width can still change after this first render: NodeView.finalizeSize
    // measures with fallback-font metrics on first paint (the web font loads async) and
    // re-snaps its own width once the real font is ready, which shifts that card's socket dots.
    // Nothing else observes that per-node resize (the ResizeObserver above only watches this
    // root, whose own box does not change when a child card resizes), so a wire drawn on the
    // first render points at a pre-font-load dot position until some later edit happens to
    // redraw it. Redraw once more here, after every initial node view's own re-snap (registered
    // by the `this.render()` call just above) has had a chance to run first.
    const fonts = document.fonts as FontFaceSet | undefined;
    if (fonts !== undefined) {
      fonts.ready.then(() => this.redrawWires()).catch(() => {});
    }
  }

  /**
   * Selects and frames a single node by id - the graph error strip's "jump to this node" click
   * (graphPanel.ts). Reuses {@link boundsOf}, the same lookup `frameGraph`'s "f" hotkey frames a
   * selection with, so a stale/unknown id (a since-deleted node, or one that belongs to the other
   * graph) is a silent no-op rather than a thrown error - a compiler message can outlive the node
   * it named across an intervening edit.
   */
  public focusNode(nodeId: string): void {
    const rectangle = this.boundsOf([nodeId], []);
    if (rectangle === undefined) {
      return;
    }
    this.selected.clear();
    this.selectedComments.clear();
    this.selected.add(nodeId);
    this.refreshSelection();
    this.viewport.frameRect(rectangle, this.root.getBoundingClientRect());
    this.redrawWires();
  }

  private activeSlot(): GraphSlot {
    return this.graphView.mode === GraphMode.Render ? "renderGraph" : "behaviorGraph";
  }

  private activeKind(): GraphKind {
    return this.graphView.mode === GraphMode.Render ? GraphKind.Render : GraphKind.Behavior;
  }

  /** Which render entity the active graph drives - reshapes the surface sink (mesh vs particle). */
  private activeRenderHost(): RenderHost {
    return selectActiveGraphOwner(this.store).kind === "vfxMesh" ? "mesh" : "particle";
  }

  /** The content library's current mesh asset names, offered by the surface sink's Geometry parameter. */
  private meshAssetNames(): readonly string[] {
    return selectMeshAssets(this.store).map((asset) => asset.name);
  }

  /** The add-node palette for the active graph, minus the particle-only nodes on a VFX mesh. */
  private paletteForActive(): readonly FXNodeMeta[] {
    const palette = paletteForKind(this.activeKind());
    if (selectActiveGraphOwner(this.store).kind === "vfxMesh") {
      return palette.filter((metadata) => !isMeshExcludedRenderNode(metadata));
    }
    return palette;
  }

  private activeGraph(): EditorGraph {
    return this.graphView.mode === GraphMode.Render
      ? selectActiveGraphOwner(this.store).renderGraph
      : selectBehaviorGraph(this.store);
  }

  private render(): void {
    const owner = selectActiveGraphOwner(this.store);
    // A VFX mesh has no behavior graph: force the Render view. setMode fires onChange -> render()
    // again, so return and let that pass draw the graph.
    if (owner.kind === "vfxMesh" && this.graphView.mode !== GraphMode.Render) {
      this.graphView.setMode(GraphMode.Render);
      return;
    }
    // Switching the active graph owner swaps in a different graph whose nodes are unrelated to the
    // current selection, so drop any selection carried over from the previous owner.
    const ownerKey = `${owner.kind}:${owner.id}`;
    if (ownerKey !== this.activeOwnerKey) {
      this.activeOwnerKey = ownerKey;
      this.selected.clear();
      this.selectedComments.clear();
    }
    // Switching graphs (a different object, or this object's other graph) re-frames on the whole
    // graph - the "f" gesture - rather than restoring a remembered pan/zoom. Deferred inside
    // switchTo until the freshly-built nodes can be measured.
    this.camera.switchTo(`${ownerKey}:${this.graphView.mode}`);
    const graph = this.activeGraph();
    // Connectivity up front: it decides which editable-input value editors collapse, so a
    // node's view is (re)built against its current connected inputs and repainted below.
    const fills = computeSocketFills(graph, (binding) => this.sinkNodeId(binding));
    const noFills: ReadonlySet<string> = new Set();
    // One palette bridge for every node built this pass - it only closes over `this.store`, so
    // there is nothing per-node to vary.
    const paletteAccess = createPaletteAccess(this.store);
    // Live per-node cost for the header badge - computed once for the whole graph (it mints a
    // throwaway set of real engine nodes internally), not per view.
    const costs = computeNodeCosts(this.activeKind(), graph);
    // A sink has no per-node engine cost of its own (see `costs` above); its header instead shows
    // its own graph's reachable-cost total - each behavior phase separately, since spawn and
    // update share one FXGraph but are otherwise unrelated kernels.
    const sinkCosts: ReadonlyMap<string, number> =
      this.activeKind() === GraphKind.Render
        ? new Map([[RENDER_SINK_ID, computeSinkCost(GraphKind.Render, graph)]])
        : new Map([
            [SPAWN_SINK_ID, computeSinkCost(GraphKind.Behavior, graph, "spawn")],
            [UPDATE_SINK_ID, computeSinkCost(GraphKind.Behavior, graph, "update")],
          ]);

    for (const [id, view] of this.nodeViews) {
      const node = graph.nodes[id];
      // Drop a view whose node left the graph, or whose socket shape changed (the render
      // sink's material, a behavior sink's attribute set, or an editable input gaining/
      // losing a wire) so it is rebuilt below.
      if (node === undefined || this.shapeKeys.get(id) !== this.shapeKeyFor(node, graph)) {
        view.dispose();
        view.element.remove();
        this.nodeViews.delete(id);
        this.shapeKeys.delete(id);
        if (node === undefined) {
          this.selected.delete(id);
        }
      }
    }

    for (const node of Object.values(graph.nodes)) {
      // Routes are fake nodes with their own lightweight view; reconciled below.
      if (isFakeNodeType(node.type)) {
        continue;
      }
      let view = this.nodeViews.get(node.id);
      if (view === undefined) {
        const nodeId = node.id;
        const metadata = resolveNodeMeta(
          this.activeKind(),
          node,
          graph,
          graph.attributes,
          this.activeRenderHost(),
          this.meshAssetNames(),
        );
        view = new NodeView(
          node,
          metadata,
          (key, value) => updateNodeParam(this.store, this.activeSlot(), nodeId, key, value),
          // Live preview during a scrub/drag, never touching undo history (see updateNodeParam's
          // `live` param) - omitted entirely for the behavior graph, whose params then report
          // nothing until the gesture's final onParamChange above (per the user's own request: a
          // behavior-graph edit forces a full simulation rebuild, so it must not run mid-drag).
          this.activeSlot() === "behaviorGraph"
            ? undefined
            : (key, value): void =>
                updateNodeParam(this.store, this.activeSlot(), nodeId, key, value, true),
          this.attributeConfigFor(metadata, nodeId),
          (event, socket) => this.onSocketPointerDown(event, socket),
          connectedInputKeys(fills.get(nodeId)),
          this.textureAssetOptions(metadata),
          // A behavior sink's declared attributes are its `attr:<name>` input rows. Both phase
          // sinks get the row (an attribute is written from either), but only Spawn's carries a
          // remove button and an element-type picker - attributes are declared from Spawn, so
          // Update only ever *uses* them; passing `undefined` here drops both controls from its
          // rows while leaving the socket itself (and its inline value editor) fully wireable.
          node.type === SPAWN_SINK_TYPE
            ? (name: string): void => removeAttribute(this.store, "behaviorGraph", name)
            : undefined,
          node.type === SPAWN_SINK_TYPE
            ? (name: string, type: AttributeTypeName): void =>
                setAttributeType(this.store, "behaviorGraph", name, type)
            : undefined,
          costs.get(nodeId),
          sinkCosts.get(nodeId),
          paletteAccess,
        );
        if (isSink(node)) {
          view.element.classList.add("node--output");
        } else if (isTimelineValueType(node.type)) {
          view.element.classList.add("node--timeline-value");
        }
        this.mountSinkAttributes(view.element, node);
        view.element.addEventListener("pointerdown", (event) =>
          this.onNodePointerDown(event, node.id),
        );
        this.content.append(view.element);
        // Now that the card is in the DOM, size its width to content and snap to the grid.
        view.finalizeSize();
        this.nodeViews.set(node.id, view);
        this.shapeKeys.set(node.id, this.shapeKeyFor(node, graph));
      }
      view.update(node, this.selected.has(node.id), costs.get(node.id), sinkCosts.get(node.id));
    }

    for (const [id, view] of this.nodeViews) {
      view.applySocketFills(fills.get(id) ?? noFills);
    }

    this.reconcileRoutes(graph, fills, noFills);
    this.reconcileComments(graph);

    // Rebuilt views start clean, so (re)apply the current compiler-error highlights against
    // them - a mode switch or structural edit lands here before the next derive arrives.
    this.applyErrorHighlights();
    this.redrawWires();
  }

  private applyErrorHighlights(): void {
    const status =
      this.graphView.mode === GraphMode.Render
        ? selectRenderStatus(this.store)
        : selectBehaviorStatus(this.store);
    paintErrorHighlights(this.nodeViews, status);
  }

  /** Builds/updates/drops the route (reroute knot) views to match the graph's route nodes. */
  private reconcileRoutes(
    graph: EditorGraph,
    fills: Map<string, Set<string>>,
    noFills: ReadonlySet<string>,
  ): void {
    for (const [id, view] of this.routeViews) {
      if (graph.nodes[id]?.type !== ROUTE_TYPE) {
        view.element.remove();
        this.routeViews.delete(id);
        this.selected.delete(id);
      }
    }
    for (const node of Object.values(graph.nodes)) {
      if (node.type !== ROUTE_TYPE) {
        continue;
      }
      let view = this.routeViews.get(node.id);
      if (view === undefined) {
        view = new RouteView(node.id, (event, socket) => this.onSocketPointerDown(event, socket));
        view.element.addEventListener("pointerdown", (event) =>
          this.onNodePointerDown(event, node.id),
        );
        this.content.append(view.element);
        this.routeViews.set(node.id, view);
      }
      view.setPosition(node.position.x, node.position.y);
      view.setSelected(this.selected.has(node.id));
      view.applyType(carriedTypeForRoute(this.activeKind(), graph, node.id));
      view.applySocketFills(fills.get(node.id) ?? noFills);
    }
  }

  /** Builds/updates/drops the comment-box views to match the graph's comments. */
  private reconcileComments(graph: EditorGraph): void {
    const comments = graph.comments;
    const present = new Set(comments.map((comment) => comment.id));
    for (const [id, view] of this.commentViews) {
      if (!present.has(id)) {
        view.element.remove();
        this.commentViews.delete(id);
        this.selectedComments.delete(id);
      }
    }
    for (const comment of comments) {
      let view = this.commentViews.get(comment.id);
      if (view === undefined) {
        const commentId = comment.id;
        view = new CommentView({
          onHeaderPointerDown: (event): void =>
            this.commentGestures.onHeaderPointerDown(event, commentId),
          onHandlePointerDown: (event, corner): void =>
            this.commentGestures.onResize(event, commentId, corner),
          onRename: (text): void => renameComment(this.store, this.activeSlot(), commentId, text),
        });
        this.commentLayer.append(view.element);
        this.commentViews.set(comment.id, view);
      }
      view.setPosition(comment.position.x, comment.position.y);
      view.setSize(comment.size.width, comment.size.height);
      view.setText(comment.text);
      view.setSelected(this.selectedComments.has(comment.id));
    }
  }

  private refreshSelection(): void {
    for (const [id, view] of this.nodeViews) {
      view.element.classList.toggle("node--selected", this.selected.has(id));
    }
    for (const [id, view] of this.routeViews) {
      view.setSelected(this.selected.has(id));
    }
    for (const [id, view] of this.commentViews) {
      view.setSelected(this.selectedComments.has(id));
    }
  }

  /** Opens the add-node menu at a screen point, dropping the picked node grid-snapped there. */
  private openAddMenu(clientX: number, clientY: number): void {
    const snapped = this.snappedGraphPoint(clientX, clientY);
    // Only real (compiled) nodes are listed; routes and comments are created by hotkey.
    const items = this.paletteForActive().map((metadata) => ({
      type: metadata.type,
      label: nodeLabel(metadata.type) ?? metadata.type,
      tags: [...searchTagsFor(metadata), ...nodeSearchTags(metadata.type)],
      description: nodeDescription(metadata.type, { domain: metadata.domain }),
    }));
    this.menu.open(clientX, clientY, items, (type) => {
      this.spawnAndSelect(type, snapped);
    });
  }

  /**
   * A wire dragged out of an OUTPUT socket and dropped in empty space: opens the add-node menu
   * filtered to nodes that accept the dragged type on some input, and on pick spawns the node
   * already wired from `output` into its first compatible input. Nodes with no matching input
   * are omitted entirely, so the list only offers valid destinations for this value.
   */
  private openAddMenuFromOutput(output: SocketRef, clientX: number, clientY: number): void {
    const snapped = this.snappedGraphPoint(clientX, clientY);
    // Pair each eligible node with the first input that accepts the dragged type; the pick wires
    // straight into it. Generic inputs list as "T" in the unresolved metadata and accept anything.
    const candidates = this.paletteForActive()
      .map((metadata) => ({
        metadata,
        input: metadata.inputs.find((socket) =>
          inputAcceptsSource(output.type, socket.type, acceptedGenericTypesForMeta(metadata)),
        ),
      }))
      .filter(
        (entry): entry is { metadata: FXNodeMeta; input: FXSocketMeta } =>
          entry.input !== undefined,
      );
    const items = candidates.map(({ metadata }) => ({
      type: metadata.type,
      label: nodeLabel(metadata.type) ?? metadata.type,
      tags: [...searchTagsFor(metadata), ...nodeSearchTags(metadata.type)],
      description: nodeDescription(metadata.type, { domain: metadata.domain }),
    }));
    this.menu.open(
      clientX,
      clientY,
      items,
      (type) => {
        const id = this.spawnAndSelect(type, snapped);
        const input = candidates.find((entry) => entry.metadata.type === type)?.input;
        if (id !== undefined && input !== undefined) {
          this.authorEdge(output, {
            nodeId: id,
            socketKey: input.key,
            side: "input",
            type: input.type,
          });
        }
      },
      // Drop the suspended ghost wire once the menu closes - whether a node was picked (the real
      // edge replaces it) or the menu was dismissed (Escape / outside click).
      () => {
        this.pending = undefined;
        this.redrawWires();
      },
    );
  }

  /** The grid-snapped graph point under a screen coordinate (where an added node drops). */
  private snappedGraphPoint(clientX: number, clientY: number): GraphPosition {
    const graphPoint = this.viewport.screenToGraph(
      clientX,
      clientY,
      this.root.getBoundingClientRect(),
    );
    return { x: snapToGrid(graphPoint.x), y: snapToGrid(graphPoint.y) };
  }

  /** Spawns a catalog node at `position`, makes it the sole selection, and returns its id. */
  private spawnAndSelect(type: string, position: GraphPosition): string | undefined {
    const id = addCatalogNode(this.store, this.activeSlot(), type, position);
    if (id !== undefined) {
      this.selected.clear();
      this.selectedComments.clear();
      this.selected.add(id);
      this.refreshSelection();
    }
    return id;
  }

  /**
   * Wheel handling, mode-dependent. On a **trackpad**, a plain two-finger scroll pans
   * (the browser reports it as a wheel with `deltaX`/`deltaY`) and a pinch arrives as a
   * `ctrlKey` wheel that zooms. On a **mouse**, the wheel zooms in discrete steps. A pinch
   * (`ctrlKey`) always zooms smoothly, in either mode.
   */
  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const bounds = this.root.getBoundingClientRect();
    if (this.inputMode.mode === InputMode.Touchpad && !event.ctrlKey) {
      // Two-finger scroll: pan the view opposite the scroll delta so the graph follows the fingers.
      this.viewport.panBy(-event.deltaX, -event.deltaY);
      return;
    }
    // Pinch-zoom (ctrlKey) scales continuously with the gesture; a mouse wheel steps by a fixed
    // factor so each notch is a predictable zoom. The mouse notch runs through the direction lock
    // so a stray reverse notch does not flip the zoom mid-gesture.
    const factor = event.ctrlKey
      ? Math.exp(-event.deltaY * 0.01)
      : this.wheelDirection.resolve(event.deltaY, event.timeStamp) < 0
        ? 1.1
        : 1 / 1.1;
    this.viewport.zoomAt(event.clientX, event.clientY, bounds, factor);
  }

  /**
   * Empty-space press. The **right** button pans on drag and opens the add-node menu on a
   * plain click (no drag); the **left** button rubber-band-selects on drag and clears the
   * selection on a plain click. (Presses on a node/socket are handled there and never reach
   * here for the left button; right-button presses bubble up so a pan can start anywhere.)
   */
  private onBackgroundPointerDown(event: PointerEvent): void {
    if (event.button === 2) {
      this.beginRightDrag(event);
    } else if (event.button === 0 && event.altKey) {
      // Alt on empty space is the wire-editing gesture: a click on a wire inserts a route,
      // a drag draws a knife stroke that cuts every wire it crosses.
      this.knifeGesture.begin(event);
    } else if (event.button === 0) {
      this.marqueeGesture.begin(event);
    }
  }

  /** Right-button gesture: pan past the drag threshold, else open the add-node menu. */
  private beginRightDrag(event: PointerEvent): void {
    let lastX = event.clientX;
    let lastY = event.clientY;
    beginPointerDrag(this.root, event, {
      threshold: PAN_DEADZONE,
      capture: false,
      onMove: (move) => {
        // Wires live inside the transformed content layer, so they pan with it - no redraw.
        this.viewport.panBy(move.clientX - lastX, move.clientY - lastY);
        lastX = move.clientX;
        lastY = move.clientY;
      },
      onEnd: (up, dragged) => {
        if (!dragged) {
          this.openAddMenu(up.clientX, up.clientY);
        }
      },
    });
  }

  // Alt wire editing (insert route / knife-cut).

  /** Every drawn edge with its wire polyline (graph coords) and how to address it for removal. */
  private collectEdges(): GraphEdge[] {
    return collectEdges(
      this.activeGraph(),
      (nodeId, socketKey, side) => this.socketCenter(nodeId, socketKey, side),
      (binding) => this.sinkNodeId(binding),
    );
  }

  /** The edge whose polyline passes nearest a graph point within the hit tolerance, if any. */
  private edgeNearPoint(point: GraphPoint): GraphEdge | undefined {
    return edgeNearPoint(this.collectEdges(), point, WIRE_HIT_TOLERANCE / this.viewport.scale);
  }

  private onNodePointerDown(event: PointerEvent, id: string): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();

    if (event.shiftKey) {
      if (this.selected.has(id)) {
        this.selected.delete(id);
      } else {
        this.selected.add(id);
      }
    } else if (!this.selected.has(id)) {
      this.selected.clear();
      this.selected.add(id);
    }
    this.refreshSelection();

    // Drag the whole current selection together (it always contains this node, unless a
    // shift-click just removed it - then there is nothing to drag from here).
    const graph = this.activeGraph();
    const movers: {
      readonly id: string;
      readonly view: { setPosition(x: number, y: number): void };
      readonly origin: GraphPosition;
    }[] = [];
    for (const selectedId of this.selected) {
      const view = this.nodeViews.get(selectedId) ?? this.routeViews.get(selectedId);
      const node = graph.nodes[selectedId];
      if (view !== undefined && node !== undefined) {
        movers.push({ id: selectedId, view, origin: node.position });
      }
    }
    // Comments selected alongside the nodes (e.g. via a marquee) ride along with the group so
    // the whole selection moves as one; each comment carries only itself here - its "drag my
    // contents" behavior is exclusive to grabbing a comment by its own header.
    const commentMovers: {
      readonly id: string;
      readonly view: { setPosition(x: number, y: number): void };
      readonly origin: GraphPosition;
    }[] = [];
    for (const commentId of this.selectedComments) {
      const view = this.commentViews.get(commentId);
      const comment = graph.comments.find((candidate) => candidate.id === commentId);
      if (view !== undefined && comment !== undefined) {
        commentMovers.push({ id: commentId, view, origin: comment.position });
      }
    }
    if (movers.length === 0 && commentMovers.length === 0) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let deltaX = 0;
    let deltaY = 0;
    // threshold 0: the group nudges on every move (grid-snapping makes a sub-cell wobble a no-op),
    // while `moved` gates the commit so a plain click does not write a zero move to history.
    beginPointerDrag(this.root, event, {
      capture: false,
      onMove: (move) => {
        const scale = this.viewport.scale;
        // Snap the shared offset (not each node) so the group keeps its relative layout while
        // every node - already grid-aligned - lands back on the grid.
        deltaX = snapToGrid((move.clientX - startX) / scale);
        deltaY = snapToGrid((move.clientY - startY) / scale);
        if (
          Math.abs(move.clientX - startX) > DRAG_THRESHOLD ||
          Math.abs(move.clientY - startY) > DRAG_THRESHOLD
        ) {
          moved = true;
        }
        for (const mover of movers) {
          mover.view.setPosition(mover.origin.x + deltaX, mover.origin.y + deltaY);
        }
        for (const mover of commentMovers) {
          mover.view.setPosition(mover.origin.x + deltaX, mover.origin.y + deltaY);
        }
        this.redrawWires();
      },
      onEnd: () => {
        if (!moved || (deltaX === 0 && deltaY === 0)) {
          return;
        }
        const nodeMoves = movers.map((mover) => ({
          nodeId: mover.id,
          position: { x: mover.origin.x + deltaX, y: mover.origin.y + deltaY },
        }));
        // With comments in the selection, commit both in one history step; otherwise the
        // node-only path keeps its lighter command.
        if (commentMovers.length > 0) {
          moveCommentGroup(
            this.store,
            this.activeSlot(),
            commentMovers.map((mover) => ({
              id: mover.id,
              position: { x: mover.origin.x + deltaX, y: mover.origin.y + deltaY },
            })),
            nodeMoves,
          );
        } else {
          moveNodes(this.store, this.activeSlot(), nodeMoves);
        }
      },
    });
  }

  /**
   * The graph's editing shortcuts, as a keymap the router applies while the graph is the active
   * panel. The editable-target guard and `event.code` (physical-key) matching live in the router
   * / keymap layer, so a shortcut fires the same on a non-Latin layout (the physical `C` key
   * copies whatever letter that key produces) and never hijacks a field being typed into.
   */
  private keymap(): Keymap {
    return [
      { code: "KeyC", modifier: true, run: () => this.copySelection(), preventDefault: false },
      { code: "KeyV", modifier: true, run: () => this.pasteClipboard() },
      // Delete / dissolve-aware delete of the selection.
      { code: "Delete", run: () => this.deleteSelected() },
      { code: "Backspace", run: () => this.deleteSelected() },
      { code: "KeyX", run: () => this.deleteSelected() },
      {
        // "a" opens the add-node menu at the cursor - the keyboard twin of the right-click menu.
        code: "KeyA",
        run: (): void => {
          const at = this.pointerScreenPoint();
          this.openAddMenu(at.x, at.y);
        },
      },
      // "c" is the only way to make a comment: wraps the selection, or drops a box at the cursor.
      { code: "KeyC", run: () => this.commentGestures.create(this.pointerGraphPoint()) },
      // "f" frames the selection, or the whole graph when nothing is selected.
      { code: "KeyF", run: () => this.frameGraph() },
      // "i" bakes a timeline keyframe for each selected Timeline Value node at the playhead.
      { code: "KeyI", run: () => this.keyframeSelection() },
    ];
  }

  /**
   * Bakes a keyframe at the current playhead for every selected `timeline-value` node, snapshotting
   * that node's inline `value` under its parameter name on the active emitter's track. Nodes that
   * aren't Timeline Values (or whose params are malformed) are skipped; with none selected it is a
   * no-op. The value is only *authored* here - driving it at the playhead is a later slice.
   */
  private keyframeSelection(): void {
    const owner = selectActiveGraphOwner(this.store);
    const entity = owner.kind === "vfxMesh" ? vfxMeshEntity(owner.id) : emitterEntity(owner.id);
    const graph = this.activeGraph();
    const time = this.transport.getTime();
    for (const id of this.selected) {
      const node = graph.nodes[id];
      if (node?.type !== "timeline-value") {
        continue;
      }
      const name = node.parameters["name"];
      const value = node.parameters["value"];
      if (typeof name === "string" && isKeyframeValue(value)) {
        setKeyframe(this.store, entity, name, time, value);
      }
    }
  }

  /**
   * Deletes the current selection: nodes and comments are removed outright, but a **route**
   * is *dissolved* - its wire is preserved by reconnecting through it (`x`/Delete both do this,
   * so breaking a knot never silently orphans the wire it was tidying).
   */
  private deleteSelected(): void {
    if (this.selected.size === 0 && this.selectedComments.size === 0) {
      return;
    }
    const graph = this.activeGraph();
    for (const id of this.selected) {
      if (graph.nodes[id]?.type === ROUTE_TYPE) {
        dissolveRoute(this.store, this.activeSlot(), id);
      } else {
        removeNode(this.store, this.activeSlot(), id);
      }
    }
    for (const id of this.selectedComments) {
      removeComment(this.store, this.activeSlot(), id);
    }
    this.selected.clear();
    this.selectedComments.clear();
  }

  /**
   * Copies the selected nodes/routes, the connections wholly *inside* that set (both endpoints
   * selected - edges leaving the selection are excluded), and any selected comments, into the
   * in-memory clipboard. Sinks are singletons and never copied.
   */
  private copySelection(): void {
    const graph = this.activeGraph();
    const nodes = [...this.selected]
      .map((id) => graph.nodes[id])
      .filter((node): node is GraphNode => node !== undefined && !isSink(node));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const connections = graph.connections.filter(
      (connection) => nodeIds.has(connection.from.nodeId) && nodeIds.has(connection.to.nodeId),
    );
    const comments = graph.comments.filter((comment) => this.selectedComments.has(comment.id));
    if (nodes.length === 0 && comments.length === 0) {
      return;
    }
    // Record the group's AABB centre now (needs the live view sizes) so a paste can drop that
    // centre under the cursor.
    const rectangle = this.boundsOf(
      nodes.map((node) => node.id),
      comments.map((comment) => comment.id),
    );
    const center: GraphPoint = rectangle
      ? { x: (rectangle.minX + rectangle.maxX) / 2, y: (rectangle.minY + rectangle.maxY) / 2 }
      : { x: 0, y: 0 };
    this.clipboard = {
      slot: this.activeSlot(),
      center,
      nodes: structuredClone(nodes),
      connections: structuredClone(connections),
      comments: structuredClone(comments),
    };
  }

  /**
   * Pastes the clipboard as fresh nodes/comments with new ids (a structural clone, not a second
   * reference), positioned so the group's AABB centre lands under the cursor, and selects the
   * paste. Only pastes into the graph it was copied from - the two kinds have disjoint node types.
   */
  private pasteClipboard(): void {
    if (this.clipboard?.slot !== this.activeSlot()) {
      return;
    }
    // Shift the whole fragment so its group centre sits at the cursor (grid-snapped).
    const cursor = this.pointerGraphPoint();
    const offset: GraphPosition = {
      x: snapToGrid(cursor.x - this.clipboard.center.x),
      y: snapToGrid(cursor.y - this.clipboard.center.y),
    };
    const { nodeIds, commentIds } = pasteFragment(
      this.store,
      this.activeSlot(),
      this.clipboard,
      offset,
    );
    // The commit above already re-rendered the views; now retarget the selection onto the paste.
    this.selected.clear();
    this.selectedComments.clear();
    for (const id of nodeIds) {
      this.selected.add(id);
    }
    for (const id of commentIds) {
      this.selectedComments.add(id);
    }
    this.refreshSelection();
  }

  // Wiring.

  /**
   * The types a placed node's generic (`"T"`) input accepts: `"any"` for a route (it forwards
   * whatever it is fed), else the family/constraint set from its metadata. `undefined` when the
   * node/socket is not generic.
   */
  private acceptedGenericTypes(nodeId: string): AcceptedTypes | undefined {
    const graph = this.activeGraph();
    const node = graph.nodes[nodeId];
    if (node === undefined) {
      return undefined;
    }
    if (node.type === ROUTE_TYPE) {
      return "any";
    }
    const metadata = metaForNode(
      this.activeKind(),
      node,
      graph.attributes,
      this.activeRenderHost(),
    );
    return metadata === undefined ? undefined : acceptedGenericTypesForMeta(metadata);
  }

  /**
   * Whether the dragged `anchor` and the drop `target` may be wired, honouring the INPUT socket's
   * generic constraint (a `float` cannot feed a vector-only `split`, a `vec3` cannot feed a
   * matrix-only op) - so the editor gate matches the engine's `resolveGenerics`.
   */
  private canWire(anchor: SocketRef, target: SocketRef): boolean {
    if (anchor.side === target.side || anchor.nodeId === target.nodeId) {
      return false;
    }
    const input = anchor.side === "input" ? anchor : target;
    const accepted = input.type === "T" ? this.acceptedGenericTypes(input.nodeId) : undefined;
    return socketsCompatible(anchor, target, accepted);
  }

  /**
   * Starts a wire drag from a socket dot: press an **output** to drag toward an input, an
   * unconnected **input** to drag toward an output, or a *connected* input to detach its edge
   * and re-drag from the source output. On release: a compatible opposite-side socket commits
   * the wire; dropping an output-anchored drag on empty space opens the add-node menu instead
   * (see {@link openAddMenuFromOutput}); anything else discards the drag.
   */
  private onSocketPointerDown(event: PointerEvent, socket: SocketRef): void {
    if (event.button !== 0) {
      return;
    }
    // The dot is inside a node card; stop the press from starting a node drag / selection.
    event.stopPropagation();

    // Alt+Click on a pin breaks its link(s) outright (Unreal-style), no drag: an input drops
    // its single incoming edge; an output drops every edge leaving it.
    if (event.altKey) {
      this.breakSocketEdges(socket);
      return;
    }

    let anchor = socket;
    if (socket.side === "input") {
      const incoming = this.findIncoming(this.activeGraph(), socket);
      if (incoming !== undefined) {
        if (incoming.kind === "connection") {
          removeConnection(this.store, this.activeSlot(), incoming.id);
        } else {
          removeOutputBinding(this.store, this.activeSlot(), incoming.slot, incoming.phase);
        }
        const type =
          resolveSocketCarriedType(
            this.activeKind(),
            this.activeGraph(),
            incoming.from.nodeId,
            incoming.from.socketKey,
            "output",
          ) ?? "T";
        anchor = {
          nodeId: incoming.from.nodeId,
          socketKey: incoming.from.socketKey,
          side: "output",
          type,
        };
      }
    } else {
      // Output drag: the dot may advertise "T" (a route, or a still-unresolved generic) but the
      // drop check needs the type that actually flows, so resolve the anchor's carried type first.
      const carried = resolveSocketCarriedType(
        this.activeKind(),
        this.activeGraph(),
        socket.nodeId,
        socket.socketKey,
        "output",
      );
      if (carried !== undefined) {
        anchor = { ...socket, type: carried };
      }
    }

    const start = this.socketCenter(anchor.nodeId, anchor.socketKey, anchor.side);
    this.pending = { anchor, cursor: start ?? { x: 0, y: 0 } };
    this.redrawWires();

    beginPointerDrag(this.root, event, {
      capture: false,
      onMove: (move) => {
        this.pending = { anchor, cursor: this.graphPoint(move.clientX, move.clientY) };
        this.redrawWires();
      },
      onEnd: (up) => {
        const target = this.socketAtPoint(up.clientX, up.clientY);
        if (target !== undefined && this.canWire(anchor, target)) {
          this.pending = undefined;
          const output = anchor.side === "output" ? anchor : target;
          const input = anchor.side === "output" ? target : anchor;
          this.authorEdge(output, input);
        } else if (target === undefined && anchor.side === "output") {
          // Dropped in empty space from an output: offer only nodes that accept this type on an
          // input, and (on pick) spawn one already wired from this output into that input. Keep the
          // ghost wire pinned at the drop point while the menu is open - it reads as "suspended,
          // awaiting a node"; `openAddMenuFromOutput` clears it when the menu closes either way.
          this.pending = { anchor, cursor: this.graphPoint(up.clientX, up.clientY) };
          this.redrawWires();
          this.openAddMenuFromOutput(anchor, up.clientX, up.clientY);
        } else {
          // Nothing committed (missed / incompatible / detached-and-dropped): clear the ghost.
          this.pending = undefined;
          this.redrawWires();
        }
      },
    });
  }

  /** Breaks the link(s) on a pin: an input's single incoming edge, or all of an output's. */
  private breakSocketEdges(socket: SocketRef): void {
    if (socket.side === "output") {
      removeEdgesFromOutput(this.store, this.activeSlot(), socket.nodeId, socket.socketKey);
      return;
    }
    const incoming = this.findIncoming(this.activeGraph(), socket);
    if (incoming === undefined) {
      return;
    }
    if (incoming.kind === "connection") {
      removeConnection(this.store, this.activeSlot(), incoming.id);
    } else {
      removeOutputBinding(this.store, this.activeSlot(), incoming.slot, incoming.phase);
    }
  }

  /** Authors the edge for an output->input drop: an output binding onto a sink, else a connection. */
  private authorEdge(output: SocketRef, input: SocketRef): void {
    const inputNode = this.activeGraph().nodes[input.nodeId];
    if (inputNode === undefined) {
      return;
    }
    const from: GraphSocketReference = { nodeId: output.nodeId, socketKey: output.socketKey };
    if (isSinkType(inputNode.type)) {
      const phase = sinkPhase(inputNode.type);
      addOutputBinding(this.store, this.activeSlot(), {
        slot: input.socketKey,
        from,
        ...(phase !== undefined ? { phase } : {}),
      });
      return;
    }
    addConnection(this.store, this.activeSlot(), {
      id: nextIdentifier("conn"),
      from,
      to: { nodeId: input.nodeId, socketKey: input.socketKey },
    });
  }

  /** The edge feeding an input socket (a sink binding or a node connection), if any. */
  private findIncoming(
    graph: EditorGraph,
    input: SocketRef,
  ):
    | { readonly kind: "connection"; readonly id: string; readonly from: GraphSocketReference }
    | {
        readonly kind: "binding";
        readonly slot: string;
        readonly phase: "spawn" | "update" | undefined;
        readonly from: GraphSocketReference;
      }
    | undefined {
    const node = graph.nodes[input.nodeId];
    if (node === undefined) {
      return undefined;
    }
    if (isSinkType(node.type)) {
      const phase = sinkPhase(node.type);
      const binding = graph.outputBindings.find(
        (candidate) => candidate.slot === input.socketKey && candidate.phase === phase,
      );
      return binding === undefined
        ? undefined
        : { kind: "binding", slot: binding.slot, phase, from: binding.from };
    }
    const connection = incomingConnection(graph, input.nodeId, input.socketKey);
    return connection === undefined
      ? undefined
      : { kind: "connection", id: connection.id, from: connection.from };
  }

  /** The socket at a screen point, or `undefined`. The dot's enlarged `::before` pseudo makes
   *  it a generous (row-height) hit target while the visible dot stays small. */
  private socketAtPoint(clientX: number, clientY: number): SocketRef | undefined {
    const element = document.elementFromPoint(clientX, clientY);
    const dot = element instanceof Element ? element.closest(".socket__dot") : undefined;
    if (!(dot instanceof HTMLElement)) {
      return undefined;
    }
    const { node, socket, side, type } = dot.dataset;
    if (node === undefined || socket === undefined || type === undefined) {
      return undefined;
    }
    if (side !== "input" && side !== "output") {
      return undefined;
    }
    return { nodeId: node, socketKey: socket, side, type };
  }

  /** The reserved sink node id an output binding targets (by slot + phase) in the active graph. */
  private sinkNodeId(binding: {
    readonly slot: string;
    readonly phase?: "spawn" | "update" | undefined;
  }): string {
    if (this.activeKind() === GraphKind.Render) {
      return RENDER_SINK_ID;
    }
    return binding.phase === "spawn" ? SPAWN_SINK_ID : UPDATE_SINK_ID;
  }

  /** A socket dot's center in graph coordinates, measured from its live DOM box. */
  private socketCenter(
    nodeId: string,
    socketKey: string,
    side: "input" | "output",
  ): GraphPoint | undefined {
    const dot =
      this.nodeViews.get(nodeId)?.socketDot(side, socketKey) ??
      this.routeViews.get(nodeId)?.socketDot(side, socketKey);
    if (dot === undefined) {
      return undefined;
    }
    const rectangle = dot.getBoundingClientRect();
    return this.graphPoint(
      rectangle.left + rectangle.width / 2,
      rectangle.top + rectangle.height / 2,
    );
  }

  private graphPoint(clientX: number, clientY: number): GraphPoint {
    return this.viewport.screenToGraph(clientX, clientY, this.root.getBoundingClientRect());
  }

  /** The last pointer screen position, or the canvas centre if none is known. */
  private pointerScreenPoint(): { x: number; y: number } {
    const bounds = this.root.getBoundingClientRect();
    return (
      this.lastPointer ?? {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      }
    );
  }

  /** The graph point under the last pointer position, or the canvas centre if none is known. */
  private pointerGraphPoint(): GraphPoint {
    const client = this.pointerScreenPoint();
    return this.viewport.screenToGraph(client.x, client.y, this.root.getBoundingClientRect());
  }

  /**
   * Frames the graph (the "f" hotkey): fits the current selection when there is one, otherwise
   * the whole graph, centred and zoomed as large as fits. A no-op if there is nothing to frame.
   */
  private frameGraph(): void {
    const graph = this.activeGraph();
    const rectangle =
      this.selected.size > 0 || this.selectedComments.size > 0
        ? this.boundsOf([...this.selected], [...this.selectedComments])
        : this.boundsOf(
            Object.keys(graph.nodes),
            graph.comments.map((comment) => comment.id),
          );
    if (rectangle === undefined) {
      return;
    }
    this.viewport.frameRect(rectangle, this.root.getBoundingClientRect());
    this.redrawWires();
  }

  /** The AABB (graph coords) enclosing the given nodes/routes and comments, or `undefined`. */
  private boundsOf(
    nodeIds: readonly string[],
    commentIds: readonly string[],
  ): GraphRect | undefined {
    const graph = this.activeGraph();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of nodeIds) {
      const node = graph.nodes[id];
      const view = this.nodeViews.get(id) ?? this.routeViews.get(id);
      if (node === undefined || view === undefined) {
        continue;
      }
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + view.element.offsetWidth);
      maxY = Math.max(maxY, node.position.y + view.element.offsetHeight);
    }
    const comments = graph.comments;
    for (const id of commentIds) {
      const comment = comments.find((candidate) => candidate.id === id);
      if (comment === undefined) {
        continue;
      }
      minX = Math.min(minX, comment.position.x);
      minY = Math.min(minY, comment.position.y);
      maxX = Math.max(maxX, comment.position.x + comment.size.width);
      maxY = Math.max(maxY, comment.position.y + comment.size.height);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : undefined;
  }

  /** Rebuilds the wire layer from the graph's connections, bindings, and the pending drag. */
  private redrawWires(): void {
    this.wireRenderer.redraw(this.activeKind(), this.activeGraph(), this.pending);
  }

  /**
   * A node's socket-shape signature - a change forces a view rebuild. A behavior sink keys off
   * the graph's attribute set, the surface sink (`$out`) off its render mode; every other node
   * keys off its resolved socket shape plus whatever else can reshape its editor (connected
   * inputs, its `valueType` choice, or - for `read-attribute`/`texture` - the library it picks from).
   */
  private shapeKeyFor(node: GraphNode, graph: EditorGraph): string {
    if (node.type === RENDER_SINK_TYPE) {
      // The host gates the surface sockets (an emitter's sink has `particleTransform`, a mesh's does
      // not), and the reserved sink id is shared across both owners' render graphs - so without the
      // host here the stale sink view survives an emitter<->mesh switch with the wrong sockets.
      // The Geometry parameter's option list also depends on the content library's mesh assets - fold
      // their names in so an upload/delete refreshes the dropdown.
      // JSON-encoded, not comma-joined: an uploaded mesh's name is unsanitized user text (ingestMesh
      // does not identifier-sanitize it, unlike texture names) and could itself contain a comma.
      return (
        `renderMode:${String(node.parameters["renderMode"])}|host:${this.activeRenderHost()}` +
        `|meshes:${JSON.stringify(this.meshAssetNames())}`
      );
    }
    if (node.type === SPAWN_SINK_TYPE || node.type === UPDATE_SINK_TYPE) {
      return `attrs:${JSON.stringify(graph.attributes)}`;
    }
    // A polymorphic node's resolved socket shape (types + component count) drives a
    // rebuild, so recoloring/adding/removing a port on a type or wiring change lands.
    const metadata = resolveNodeMeta(
      this.activeKind(),
      node,
      graph,
      graph.attributes,
      this.activeRenderHost(),
    );
    const shape = socketShapeSignature(metadata);
    // A wire into an editable input collapses its inline value editor (and a removal expands
    // it), changing the card's rows - fold the node's connected inputs in so it rebuilds.
    const wiredInputs = graph.connections
      .filter((connection) => connection.to.nodeId === node.id)
      .map((connection) => connection.to.socketKey)
      .sort()
      .join(",");
    // `color` and `vec4` resolve to the same vec4 socket, so the signature can't tell them apart,
    // but their inline editors differ (picker vs raw fields) - fold the raw valueType in to rebuild.
    const valueTypeKey =
      metadata === undefined
        ? undefined
        : Object.entries(metadata.params).find(
            ([, parameter]) => parameter.kind === "structural" && parameter.type === "valueType",
          )?.[0];
    const editorShape =
      valueTypeKey === undefined ? "" : `|valueType:${String(node.parameters[valueTypeKey])}`;
    const base = `${shape}|in:${wiredInputs}${editorShape}`;
    // A read-attribute node's picker lists the declared attributes; rebuild it when that
    // set changes so a freshly-declared (or removed/retyped) attribute shows up at once.
    if (node.type === "read-attribute") {
      return `${base}|attrs:${JSON.stringify(selectBehaviorGraph(this.store).attributes)}`;
    }
    // A Texture's picker lists the library's assets and its body previews the chosen
    // one; rebuild when that set changes so a freshly-uploaded (or deleted) texture shows up in
    // the dropdown, and when an asset's dimensions change so a replaced image repaints the preview.
    if (node.type === "texture") {
      const signature = selectTextureAssets(this.store)
        .map((asset) => `${asset.name}:${asset.width}x${asset.height}`)
        .join(",");
      return `${base}|assets:${signature}`;
    }
    return base;
  }

  /**
   * For an attribute node (`read-attribute`): the picker config listing the graph's declared
   * attributes. Choosing one is a structural edit, so it replaces the node (new id).
   */
  private attributeConfigFor(
    metadata: ReturnType<typeof metaForNode>,
    nodeId: string,
  ): AttributeNodeConfig | undefined {
    const isAttributeNode = metadata?.customParams?.some(
      (parameter) => parameter.kind === "attribute-name",
    );
    if (isAttributeNode !== true) {
      return undefined;
    }
    // Readable builtins (position/age/lifetime) precede the declared attributes on both graphs:
    // the behavior and render read nodes both resolve them to the matching `PARTICLE_*` target
    // inputs (the render side reads the `p_position`/`p_lifecycle` varyings).
    const builtins = READABLE_BUILTINS;
    return {
      options: [...builtins, ...selectBehaviorGraph(this.store).attributes].map((attribute) => ({
        name: attribute.name,
        type: attribute.type,
      })),
      onSelect: (name, type): void => {
        const newId = replaceNodeParams(this.store, this.activeSlot(), nodeId, { name, type });
        if (newId !== undefined) {
          this.selected.clear();
          this.selected.add(newId);
        }
      },
    };
  }

  /** The library's texture assets, offered to a Texture node's picker (empty otherwise). */
  private textureAssetOptions(
    metadata: ReturnType<typeof metaForNode>,
  ): readonly TextureAssetOption[] {
    if (metadata?.type !== "texture") {
      return [];
    }
    return selectTextureAssets(this.store).map((asset) => ({
      name: asset.name,
      label: asset.label,
      dataUrl: asset.dataUrl,
    }));
  }

  /** Adds the "declare a new attribute" row to Spawn's card - attributes are declared once, from
   *  Spawn, and the resulting write slot then appears on both phase sinks (see
   *  `mountSinkAttributes`'s caller for the read/write side, shared by both). */
  private mountSinkAttributes(element: HTMLElement, node: GraphNode): void {
    if (node.type !== SPAWN_SINK_TYPE) {
      return;
    }
    // The card's fixed (grid-snapped) height covers only the sockets; let it grow to fit
    // the attribute editor below them.
    element.style.height = "auto";
    element.append(
      buildSinkAttributes({
        onAdd: (name, type) => addAttribute(this.store, "behaviorGraph", name, type),
      }),
    );
  }
}
