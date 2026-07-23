/**
 * Timeline region: the scene's objects (VFX group, emitters, meshes) and their animation, each as a
 * label row + time lane, under one playhead. The transport is transient; length/fps are authored.
 */

import { t } from "../../i18n";
import {
  addBurstEvent,
  addPlayEvent,
  removeEvent,
  removeKeyframe,
  removeTransformKeyframe,
  setKeyframe,
  setLiveChannel,
  setLiveParam,
  setProjectName,
  setTransformKeyframe,
} from "../../model/commands";
import {
  projectDisplayName,
  type EmitterDoc,
  type VfxDoc,
  type VfxMeshDoc,
} from "../../model/editorState";
import {
  emitterEntity,
  sameEntity,
  vfxMeshEntity,
  VFX_ENTITY,
  type SceneEntity,
} from "../../model/entity";
import { snapTimeToFrame } from "../../model/frames";
import { selectEmitters, selectMeshes, selectVfx } from "../../model/selectors";
import type { TransformChannel, TransformTrack } from "../../model/transform";
import { TRANSFORM_CHANNELS } from "../../model/transform";
import { sampleTrack } from "../../model/trackSampling";
import { isTimelineValueType } from "../../domain/nodePalette";
import type { EditorGraph } from "../../domain/graphModel";
import { isKeyframeValue } from "../../domain/graphModel";
import { openContextMenu } from "../components/contextMenu";
import { beginPointerDrag } from "../primitives/drag";
import { fractionAcross } from "../primitives/geometry";
import { clamp } from "../primitives/math";
import { fraction, timeAtFraction } from "./timelineFormat";
import { clearChildren, createElement } from "../dom";
import type { EditorContext } from "../editorContext";
import { EditorPanel } from "../focus/panelFocus";
import {
  channelValueAt,
  emitterIdOf,
  timelineValueRows,
  type TimelineValueRow,
} from "./timelineQueries";
import { buildLabel, buildMeshLabel } from "./timelineRowLabel";
import { beginPlayheadScrub } from "./timelineScrub";
import { beginItemDrag, type ItemDragContext } from "./timelineItemDrag";
import { beginMarquee, type MarqueeContext } from "./timelineMarquee";
import { renderTimelineInspector, type InspectorContext } from "./timelineInspector";
import {
  appendSummaryKeys,
  buildChannelLabel,
  buildEntityLabel,
  buildTrackLabel,
  eventMarkers,
  keyframeMarkers,
  transformKeyMarkers,
} from "./timelineRows";
import {
  DRAG_THRESHOLD,
  selectionKey,
  type ItemPointerHandler,
  type ItemRef,
  type Marker,
} from "./timelineTypes";
import { TimelineViewport } from "./timelineViewport";
import { commitEntitySelection } from "../selection";

export function createTimelinePanel(context: EditorContext): HTMLElement {
  const { store, signals, transport, router, selection: timelineSelection } = context;
  const selection = new Set<string>();
  let markers: Marker[] = [];
  let refByKey = new Map<string, ItemRef>();

  const duration = (): number => store.getSource().timeline.duration;
  const fps = (): number => store.getSource().timeline.fps;

  // Transport + timeline-setting controls live on the middlebar (transportControls.ts); this panel is
  // just the object rows, playhead, and inspector.
  const rows = createElement("div", { className: "timeline__rows" });
  const scroll = createElement("div", { className: "timeline__scroll" }, [rows]);
  // The end caps double as grab handles: pressing anywhere on the caret scrubs (see beginPlayheadScrub).
  const playhead = createElement("div", { className: "timeline__playhead" }, [
    createElement("div", { className: "timeline__playhead-cap timeline__playhead-cap--top" }),
    createElement("div", { className: "timeline__playhead-cap timeline__playhead-cap--bottom" }),
  ]);
  playhead.addEventListener("pointerdown", (down) =>
    beginPlayheadScrub(down, { rows, transport, duration, fps }),
  );
  const stage = createElement("div", { className: "timeline__stage" }, [scroll, playhead]);
  const inspector = createElement("div", { className: "timeline__inspector" });
  const grid = createElement("div", { className: "timeline__grid" }, [stage, inspector]);
  const element = createElement("div", { className: "timeline" }, [grid]);
  element.tabIndex = 0;

  // Horizontal zoom + the bottom scrollbar. It widens the lanes (leaving the pointer math intact)
  // and owns the caret's pixel position, so it must exist before the first render/transport tick.
  const viewport = new TimelineViewport({
    scroll,
    rows,
    playhead,
    stage,
    duration,
    fps,
    progress: (): number => fraction(transport.getTime(), duration()),
  });
  element.append(viewport.element);

  // Repaint after any selection change: restyle the markers + rebuild the inspector. Shared by the
  // drag / marquee controllers (through their contexts) and the panel's own selection edits.
  const inspectorContext: InspectorContext = { inspector, store, fps, removeSelected };
  const refresh = (): void => {
    applySelectionStyles();
    renderTimelineInspector(selection, refByKey, inspectorContext);
  };
  const dragContext: ItemDragContext = {
    element,
    store,
    duration,
    fps,
    markers: () => markers,
    selection,
    refresh,
  };
  const marqueeContext: MarqueeContext = {
    element,
    markers: () => markers,
    selection,
    refresh,
    // A plain left-click on empty lane also seeks the caret to that frame (drag still marquees).
    onEmptyClick: (clientX) => seekAtClientX(clientX),
  };
  const onItemPointerDown: ItemPointerHandler = (down, ref) =>
    beginItemDrag(down, ref, dragContext);

  // Clicks landing directly on `rows` (the gap below the last row) clear selection here; clicks on
  // a lane clear via beginMarquee's own click branch.
  rows.addEventListener("pointerdown", (event) => {
    if (event.target === rows) {
      selection.clear();
      refresh();
    }
  });

  // Wired through the router so Delete/Backspace only fire while the timeline is the active panel
  // and no field is being typed into (the router's shared editable guard).
  const deleteSelection = (): void => {
    if (selection.size === 0) {
      return;
    }
    removeSelected();
  };
  router.registerPanel(EditorPanel.Timeline, [
    { code: "Delete", run: deleteSelection },
    { code: "Backspace", run: deleteSelection },
    // Blender-style delete alias, same as the graph panel's KeyX.
    { code: "KeyX", run: deleteSelection },
    // F frames the whole timeline into view (Blender-style "view all").
    { code: "KeyF", run: (): void => viewport.fitTimeline() },
  ]);

  /** Repaints only the playhead position - called on every transport tick. */
  function updateTransport(): void {
    viewport.positionPlayhead();
  }

  function render(): void {
    clearChildren(rows);
    markers = [];
    // Recolor the caret while the timeline is infinite (an infinite play exists, task 2).
    playhead.classList.toggle("timeline__playhead--infinite", transport.isInfinite());
    const total = duration();
    // Exactly one object is "active" at a time (the selected entity - VFX group, emitter, or mesh);
    // only it shows its transform/value sub-rows, the rest collapse to a header.
    const active = timelineSelection.get();
    for (const row of buildVfxRows(selectVfx(store), total, sameEntity(active, VFX_ENTITY))) {
      rows.append(row);
    }
    const emitters = selectEmitters(store);
    const removable = emitters.length > 1;
    for (const emitter of emitters) {
      const expanded = sameEntity(active, emitterEntity(emitter.id));
      for (const row of buildEmitterRows(emitter, expanded, removable, total)) {
        rows.append(row);
      }
    }
    for (const mesh of selectMeshes(store)) {
      const expanded = sameEntity(active, vfxMeshEntity(mesh.id));
      for (const row of buildMeshRows(mesh, expanded, total)) {
        rows.append(row);
      }
    }
    // A growing filler row carries the timeline visual (ticks / gutters / caret) and its lane
    // interactions down over any space left below the objects (task 7).
    rows.append(buildFillerRow(total));
    finishRender();
  }

  /** An empty, height-filling row whose lane continues the timeline below the last object. */
  function buildFillerRow(total: number): HTMLElement {
    const label = createElement("div", { className: "timeline-row__label" });
    return createElement("div", { className: "timeline-row timeline-row--filler" }, [
      label,
      buildLane(total, []),
    ]);
  }

  /** The per-type accent class carrying an entity's `--row-accent` hue (task 3). */
  function rowTypeClass(entity: SceneEntity): string {
    switch (entity.kind) {
      case "emitter":
        return "timeline-row--emitter";
      case "vfxMesh":
        return "timeline-row--mesh";
      case "vfx":
        return "timeline-row--group";
    }
  }

  /** The class list for an entity's header row - the active (selected) object wears the accent. */
  function headerClass(entity: SceneEntity, active: boolean): string {
    const base = `timeline-row ${rowTypeClass(entity)}`;
    return active ? `${base} timeline-row--active` : base;
  }

  /** The class list for one of an entity's sub-rows (transform / value track). */
  function trackRowClass(entity: SceneEntity): string {
    return `timeline-row timeline-row--track ${rowTypeClass(entity)}`;
  }

  /** Selects an entity for the gizmo; selecting an emitter also makes it the graph-edited one. */
  function selectEntity(entity: SceneEntity): void {
    commitEntitySelection(store, timelineSelection, entity);
  }

  /** After (re)building rows: index markers, drop stale selection, restyle, redraw the inspector. */
  function finishRender(): void {
    refByKey = new Map(markers.map((marker) => [selectionKey(marker.ref), marker.ref]));
    for (const key of [...selection]) {
      if (!refByKey.has(key)) {
        selection.delete(key);
      }
    }
    refresh();
    // Re-apply zoom + reposition the caret against the freshly rebuilt lanes.
    viewport.refresh();
  }

  /** The VFX group's rows: header (empty lane - VFX has no spawn events) + transform sub-rows while active. */
  function buildVfxRows(vfx: VfxDoc, total: number, active: boolean): HTMLElement[] {
    const headerLane = buildLane(total, []);
    appendSummaryKeys(headerLane, vfx.transformTracks, total);
    const header = createElement("div", { className: headerClass(VFX_ENTITY, active) }, [
      buildEntityLabel(
        VFX_ENTITY,
        projectDisplayName(store.getSource().name),
        selectEntity,
        (name) => setProjectName(store, name),
      ),
      headerLane,
    ]);
    const output: HTMLElement[] = [header];
    if (!active) {
      return output; // collapsed: only the header shows
    }
    for (const channel of TRANSFORM_CHANNELS) {
      // The VFX group's channels are always live (see VfxDoc's doc); buildChannelLabel locks the
      // toggle for any vfx-kind entity independently of this list, which just keeps the call shape.
      output.push(
        buildTransformRow(
          VFX_ENTITY,
          vfx.transform,
          vfx.transformTracks,
          TRANSFORM_CHANNELS,
          channel,
          total,
        ),
      );
    }
    return output;
  }

  /** One emitter's rows: header (label + spawn-event lane) plus, while active, transform and Timeline Value sub-rows. */
  function buildEmitterRows(
    emitter: EmitterDoc,
    active: boolean,
    removable: boolean,
    total: number,
  ): HTMLElement[] {
    const entity = emitterEntity(emitter.id);
    const label = buildLabel(store, emitter, removable, () => selectEntity(entity), {
      addBurst: () => addBurstEvent(store, emitter.id, transport.getTime()),
      addPlay: () => addPlayEvent(store, emitter.id, transport.getTime()),
    });
    const eventLane = buildLane(
      total,
      eventMarkers(emitter, total, onItemPointerDown),
      (time, x, y) =>
        openContextMenu(x, y, [
          {
            label: t("timeline.addBurst"),
            run: (): string => addBurstEvent(store, emitter.id, time),
          },
          {
            label: t("timeline.addPlay"),
            run: (): string => addPlayEvent(store, emitter.id, time),
          },
        ]),
    );
    // The header lane also mirrors every keyframe from the emitter's sub-rows (task 6), so its
    // animation reads at a glance even when the object is collapsed.
    appendSummaryKeys(eventLane, [...emitter.transformTracks, ...emitter.tracks], total);
    const header = createElement("div", { className: headerClass(entity, active) }, [
      label,
      eventLane,
    ]);

    const output: HTMLElement[] = [header];
    if (!active) {
      return output; // collapsed: only the header shows
    }
    for (const channel of TRANSFORM_CHANNELS) {
      output.push(
        buildTransformRow(
          entity,
          emitter.transform,
          emitter.transformTracks,
          emitter.liveChannels,
          channel,
          total,
        ),
      );
    }
    const graphs = [emitter.renderGraph, emitter.behaviorGraph];
    for (const row of timelineValueRows(graphs, emitter.tracks)) {
      output.push(buildTimelineValueRow(entity, row, emitter.liveParams, graphs, total));
    }
    return output;
  }

  /** One VFX mesh's rows: header (empty lane - a mesh has no spawn events) plus, while active, transform and Timeline Value sub-rows. */
  function buildMeshRows(mesh: VfxMeshDoc, active: boolean, total: number): HTMLElement[] {
    const entity = vfxMeshEntity(mesh.id);
    const label = buildMeshLabel(store, mesh, () => selectEntity(entity));
    const headerLane = buildLane(total, []);
    appendSummaryKeys(headerLane, [...mesh.transformTracks, ...mesh.tracks], total);
    const header = createElement("div", { className: headerClass(entity, active) }, [
      label,
      headerLane,
    ]);

    const output: HTMLElement[] = [header];
    if (!active) {
      return output;
    }
    for (const channel of TRANSFORM_CHANNELS) {
      output.push(
        buildTransformRow(
          entity,
          mesh.transform,
          mesh.transformTracks,
          mesh.liveChannels,
          channel,
          total,
        ),
      );
    }
    const graphs = [mesh.renderGraph];
    for (const row of timelineValueRows(graphs, mesh.tracks)) {
      output.push(buildTimelineValueRow(entity, row, mesh.liveParams, graphs, total));
    }
    return output;
  }

  /**
   * One Timeline Value sub-row: label (name + add-key + live toggle) and its keyframe lane, empty
   * until `row.track` exists. Shown for every name a `timeline-value` node declares, whether or not
   * it has been keyframed yet (task: show timeline-value rows immediately).
   */
  function buildTimelineValueRow(
    entity: SceneEntity,
    row: TimelineValueRow,
    liveParams: readonly string[],
    graphs: readonly EditorGraph[],
    total: number,
  ): HTMLElement {
    const live = liveParams.includes(row.name);
    const trackLabel = buildTrackLabel(
      entity,
      row.name,
      live,
      selectEntity,
      () => insertTrackKey(entity, row, graphs),
      () => setLiveParam(store, entity, row.name, !live),
    );
    const trackLane = buildLane(
      total,
      row.track !== undefined
        ? keyframeMarkers(entity, row.track, total, fps(), onItemPointerDown)
        : [],
    );
    return createElement("div", { className: trackRowClass(entity) }, [trackLabel, trackLane]);
  }

  /** The `timeline-value` node declaring `name`'s current inline default across `graphs`, or 0. */
  function nodeDefaultValue(
    graphs: readonly EditorGraph[],
    name: string,
  ): number | readonly number[] {
    for (const graph of graphs) {
      for (const node of Object.values(graph.nodes)) {
        if (!isTimelineValueType(node.type) || node.parameters["name"] !== name) {
          continue;
        }
        const value = node.parameters["value"];
        if (isKeyframeValue(value)) {
          return value;
        }
      }
    }
    return 0;
  }

  /**
   * Bakes `row`'s current value at the caret: samples the existing track if present, else seeds
   * from the declaring node's live inline default (same source as the graph canvas's `I` shortcut).
   */
  function insertTrackKey(
    entity: SceneEntity,
    row: TimelineValueRow,
    graphs: readonly EditorGraph[],
  ): void {
    const time = snapTimeToFrame(transport.getTime(), fps());
    const value =
      row.track !== undefined
        ? (sampleTrack(row.track, time) ?? 0)
        : nodeDefaultValue(graphs, row.name);
    setKeyframe(store, entity, row.name, time, value);
  }

  /** One transform channel sub-row: an indented label + a lane of that channel's keyframes. */
  function buildTransformRow(
    entity: SceneEntity,
    base: EmitterDoc["transform"],
    tracks: readonly TransformTrack[],
    liveChannels: readonly TransformChannel[],
    channel: TransformChannel,
    total: number,
  ): HTMLElement {
    const track = tracks.find((candidate) => candidate.channel === channel);
    const keys = track?.keys ?? [];
    const live = liveChannels.includes(channel);
    const insertKey = (time: number): void =>
      setTransformKeyframe(
        store,
        entity,
        channel,
        time,
        channelValueAt(base, tracks, channel, time),
      );
    // The label's add-key button inserts at the caret (task 5); the lane's context menu at the click.
    const label = buildChannelLabel(
      entity,
      channel,
      live,
      selectEntity,
      () => insertKey(snapTimeToFrame(transport.getTime(), fps())),
      () => setLiveChannel(store, entity, channel, !live),
    );
    const lane = buildLane(
      total,
      transformKeyMarkers(entity, channel, keys, total, fps(), onItemPointerDown),
      (time, x, y) =>
        openContextMenu(x, y, [{ label: t("timeline.addKey"), run: (): void => insertKey(time) }]),
    );
    return createElement("div", { className: trackRowClass(entity) }, [label, lane]);
  }

  /** Seeks the transport to the frame under `clientX`, mapped through a lane's live geometry. */
  function seekAtClientX(clientX: number): void {
    const lane = rows.querySelector<HTMLElement>(".timeline-row__lane");
    if (!lane) {
      return;
    }
    const time = timeAtFraction(fractionAcross(clientX, lane.getBoundingClientRect()), duration());
    transport.seek(snapTimeToFrame(time, fps()));
  }

  /** Right-button lane gesture (mirrors the graph canvas): pan past the threshold, else drop the context menu. */
  function beginLanePan(
    down: PointerEvent,
    lane: HTMLElement,
    total: number,
    onContext?: (time: number, x: number, y: number) => void,
  ): void {
    down.preventDefault();
    down.stopPropagation();
    let lastX = down.clientX;
    beginPointerDrag(lane, down, {
      threshold: DRAG_THRESHOLD,
      capture: false,
      onMove: (move) => {
        viewport.panByPixels(move.clientX - lastX);
        lastX = move.clientX;
      },
      onEnd: (_up, dragged) => {
        if (!dragged && onContext !== undefined) {
          const timeFraction = fractionAcross(down.clientX, lane.getBoundingClientRect());
          // Clamp to the authored range so a right-click in the padded margin still adds in [0, end].
          const time = clamp(timeAtFraction(timeFraction, total), 0, total);
          onContext(time, down.clientX, down.clientY);
        }
      },
    });
  }

  /**
   * A time lane pre-filled with `laneMarkers`: left press marquees/seeks (see beginMarquee), right
   * press pans/context-menus (see beginLanePan).
   */
  function buildLane(
    total: number,
    laneMarkers: Marker[],
    onContext?: (time: number, x: number, y: number) => void,
  ): HTMLElement {
    const lane = createElement("div", { className: "timeline-row__lane" });
    for (const marker of laneMarkers) {
      lane.append(marker.element);
      markers.push(marker);
    }
    lane.addEventListener("pointerdown", (down) => {
      if (down.button === 2) {
        beginLanePan(down, lane, total, onContext);
      } else if (down.button === 0) {
        beginMarquee(down, marqueeContext);
      }
    });
    return lane;
  }

  function applySelectionStyles(): void {
    for (const marker of markers) {
      marker.element.classList.toggle("is-selected", selection.has(selectionKey(marker.ref)));
    }
  }

  /** Removes every selected item (keyframes, events, transform keys), then clears the selection. */
  function removeSelected(): void {
    for (const key of [...selection]) {
      const ref = refByKey.get(key);
      if (ref === undefined) {
        continue;
      }
      if (ref.kind === "transformKey") {
        removeTransformKeyframe(store, ref.entity, ref.id);
        continue;
      }
      if (ref.kind === "key") {
        removeKeyframe(store, ref.entity, ref.id);
        continue;
      }
      const emitterId = emitterIdOf(ref);
      if (emitterId !== undefined) {
        removeEvent(store, emitterId, ref.id);
      }
    }
    selection.clear();
  }

  render();
  // Structural changes (add/remove/select/rename) and view changes (keyframes, length, fps) both
  // re-render the rows; the transport itself only drives the playhead position, in place.
  signals.on("sourceStructureChanged", render);
  signals.on("sourceViewChanged", render);
  // Preview/gizmo selection changes which entity is "active" - re-render so the right row expands
  // (sub-rows) and highlights, following a selection made outside the timeline.
  timelineSelection.subscribe(render);
  transport.subscribe(updateTransport);
  // The viewport re-derives its layout on resize itself (a ResizeObserver on the scroller), which
  // also covers the initial mount and the bottom-band divider drag - so no window `resize` here.

  return element;
}
