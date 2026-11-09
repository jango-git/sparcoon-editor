import { describe, expect, it } from "vitest";
import { createEmptyGraph, type EditorGraph, type GraphNode } from "../../src/domain/graphModel";
import { addBurstEvent, setKeyframe, setTransformKeyframe } from "../../src/model/commands";
import type { AnimationTrack } from "../../src/model/editorState";
import { emitterEntity, VFX_ENTITY } from "../../src/model/entity";
import { SignalBus } from "../../src/model/signals";
import { Store } from "../../src/model/store";
import { channelValueAt, itemTime, timelineValueRows } from "../../src/ui/panels/timelineQueries";
import { createTestState } from "../helpers/testDocument";

const freshStore = (): Store => new Store(createTestState(), new SignalBus());
const emitterId = (store: Store): string => store.getSource().scene.emitters[0].id;

const timelineValue = (id: string, name: string): GraphNode => ({
  id,
  type: "timeline-value",
  parameters: { name, value: 1 },
  position: { x: 0, y: 0 },
});

const graphOf = (...nodes: GraphNode[]): EditorGraph => ({
  ...createEmptyGraph(),
  nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
});

const track = (name: string): AnimationTrack => ({
  name,
  keys: [{ id: `key_${name}`, time: 0, value: 1 }],
});

describe("timelineValueRows", () => {
  it("lists declared names in graph order, then orphaned tracks", () => {
    const graphs = [
      graphOf(timelineValue("a", "size"), timelineValue("b", "alpha")),
      graphOf(timelineValue("c", "spin")),
    ];
    const tracks = [track("orphan"), track("alpha")];

    expect(timelineValueRows(graphs, tracks)).toEqual([
      { name: "size", track: undefined }, // declared, not keyframed yet
      { name: "alpha", track: tracks[1] },
      { name: "spin", track: undefined },
      { name: "orphan", track: tracks[0] }, // keyframes left behind by a deleted node
    ]);
  });

  it("shows a name declared in several graphs once", () => {
    const graphs = [graphOf(timelineValue("a", "size")), graphOf(timelineValue("b", "size"))];
    expect(timelineValueRows(graphs, []).map((row) => row.name)).toEqual(["size"]);
  });
});

describe("itemTime", () => {
  it("resolves the time of a Timeline Value key, a transform key and an event", () => {
    const store = freshStore();
    const entity = emitterEntity(emitterId(store));
    const keyId = setKeyframe(store, entity, "size", 1, 4);
    const transformKeyId = setTransformKeyframe(store, entity, "position", 2, [0, 0, 0]);
    const eventId = addBurstEvent(store, emitterId(store), 3, 1);

    expect(itemTime(store, { entity, kind: "key", id: keyId })).toBe(1);
    expect(
      itemTime(store, { entity, kind: "transformKey", channel: "position", id: transformKeyId }),
    ).toBe(2);
    expect(itemTime(store, { entity, kind: "event", id: eventId })).toBe(3);
  });

  it("is undefined for an unknown id, and for an event on an entity without events", () => {
    const store = freshStore();
    const entity = emitterEntity(emitterId(store));
    expect(itemTime(store, { entity, kind: "key", id: "missing" })).toBeUndefined();
    expect(itemTime(store, { entity, kind: "event", id: "missing" })).toBeUndefined();
    expect(itemTime(store, { entity: VFX_ENTITY, kind: "event", id: "event_1" })).toBeUndefined();
  });
});

describe("channelValueAt", () => {
  it("reads the base transform for an unanimated channel", () => {
    const store = freshStore();
    const { transform, transformTracks } = store.getSource().scene.emitters[0];
    expect(channelValueAt(transform, transformTracks, "scale", 1)).toEqual(transform.scale);
    expect(channelValueAt(transform, transformTracks, "rotation", 1)).toEqual(transform.rotation);
  });

  it("samples an animated channel under the caret", () => {
    const store = freshStore();
    const entity = emitterEntity(emitterId(store));
    setTransformKeyframe(store, entity, "position", 0, [0, 0, 0]);
    setTransformKeyframe(store, entity, "position", 2, [2, 4, 0]);
    const { transform, transformTracks } = store.getSource().scene.emitters[0];

    const [x, y, z] = channelValueAt(transform, transformTracks, "position", 1);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(2, 6);
    expect(z).toBeCloseTo(0, 6);
  });
});
