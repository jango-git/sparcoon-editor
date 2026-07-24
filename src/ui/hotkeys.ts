/**
 * Global (undo/redo, Ctrl+S save) and transport (Space play/pause, <-/-> frame step) hotkeys,
 * contributed to the {@link HotkeyRouter} as declarative keymaps. Transport keys are scoped to the
 * Viewport and Timeline only - the graph owns its own editing keys.
 */

import { frameOf, timeOfFrame } from "../model/frames";
import type { Store } from "../model/store";
import type { TransportStore } from "../model/transport";
import { EditorPanel } from "./focus/panelFocus";
import type { HotkeyRouter } from "./focus/hotkeyRouter";
import type { Keymap } from "./focus/keymap";
import { saveProjectJson } from "./projectExportPanel";

export function installHotkeys(
  router: HotkeyRouter,
  store: Store,
  transport: TransportStore,
): void {
  router.registerGlobal(globalKeymap(store));

  // The Viewport and Timeline share one transport keymap: both are places where you watch and
  // scrub the effect, so Space and the frame-step arrows behave identically in either.
  const transportMap = transportKeymap(store, transport);
  router.registerPanel(EditorPanel.Viewport, transportMap);
  router.registerPanel(EditorPanel.Timeline, transportMap);
}

function globalKeymap(store: Store): Keymap {
  return [
    { code: "KeyZ", modifier: true, shift: false, run: () => store.undo() },
    { code: "KeyZ", modifier: true, shift: true, run: () => store.redo() },
    // allowInEditable: the browser's own Save Page dialog is never wanted here, including while
    // a param field or the project name input owns focus.
    { code: "KeyS", modifier: true, allowInEditable: true, run: () => saveProjectJson(store) },
  ];
}

function transportKeymap(store: Store, transport: TransportStore): Keymap {
  return [
    {
      // Space toggles playback (like a video scrubber); preventDefault stops it also activating
      // a focused button or scrolling the page.
      code: "Space",
      run: (): void => {
        if (transport.isPlaying()) {
          transport.pause();
        } else {
          transport.play();
        }
      },
    },
    { code: "ArrowLeft", run: () => stepFrame(store, transport, -1) },
    { code: "ArrowRight", run: () => stepFrame(store, transport, 1) },
  ];
}

/** Nudges the playhead by whole frames, clamped at the timeline start (seek clamps the end). */
function stepFrame(store: Store, transport: TransportStore, delta: number): void {
  const fps = store.getSource().timeline.fps;
  const frame = frameOf(transport.getTime(), fps);
  transport.seek(timeOfFrame(Math.max(0, frame + delta), fps));
}
