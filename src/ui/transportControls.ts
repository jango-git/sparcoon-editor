/**
 * The transport + timeline-settings controls, hoisted onto the middlebar: transport buttons, length /
 * FPS fields (the editor's scrubbable {@link NumberControl}) and the "restart on rebuild" toggle.
 * Only drives {@link TransportStore} and the timeline-setting commands, and reflects transport ticks
 * + authored-length changes back into its fields; holds no document state.
 */

import { t } from "../i18n";
import { setTimelineDuration, setTimelineFps } from "../model/commands";
import { frameOf, timeOfFrame } from "../model/frames";
import type { SignalBus } from "../model/signals";
import type { Store } from "../model/store";
import type { TransportStore } from "../model/transport";
import { NumberControl } from "./components/numberControl";
import { createToggleButton } from "./components/toggleButton";
import { attachTooltip } from "./components/tooltip";
import { createElement } from "./dom";
import { controlIcons, icon } from "./icons";

export function createTransportControls(
  store: Store,
  signals: SignalBus,
  transport: TransportStore,
): HTMLElement {
  const duration = (): number => store.getSource().timeline.duration;
  const fps = (): number => store.getSource().timeline.fps;

  const jumpToStart = transportButton(
    controlIcons.jumpToStart,
    t("transport.jumpToStart"),
    t("transport.jumpToStartTip"),
  );
  const back = transportButton(
    controlIcons.stepBack,
    t("transport.stepBack"),
    t("transport.stepBackTip"),
  );
  const play = transportButton(
    controlIcons.play,
    t("transport.playPause"),
    t("transport.playPauseTip"),
  );
  const forward = transportButton(
    controlIcons.stepForward,
    t("transport.stepForward"),
    t("transport.stepForwardTip"),
  );
  const lengthControl = new NumberControl({
    value: duration(),
    min: 0.1,
    step: 0.1,
    onChange: (value): void => setTimelineDuration(store, value),
    live: (value): void => setTimelineDuration(store, value, true),
  });
  const fpsControl = new NumberControl({
    value: fps(),
    min: 10,
    max: 90,
    step: 2,
    precision: 0,
    onChange: (value): void => setTimelineFps(store, value),
    live: (value): void => setTimelineFps(store, value, true),
  });

  const restart = createToggleButton({
    glyph: controlIcons.restartOnRebuild,
    title: t("transport.restartOnRebuild"),
    description: t("transport.restartOnRebuildTip"),
    value: transport.restartOnRebuild,
    onChange: (on) => transport.setRestartOnRebuild(on),
    // Match the 28x28 middlebar buttons rather than the 24x24 in-panel toggles.
    className: "toggle-button--lg",
  });

  jumpToStart.addEventListener("click", () => transport.seek(0));
  back.addEventListener("click", () => stepFrame(store, transport, -1));
  forward.addEventListener("click", () => stepFrame(store, transport, 1));
  play.addEventListener("click", () => {
    if (transport.isPlaying()) {
      transport.pause();
    } else {
      transport.play();
    }
  });

  const element = createElement("div", { className: "transport-bar" }, [
    createElement("div", { className: "timeline__transport" }, [
      jumpToStart,
      back,
      play,
      forward,
    ]),
    group(
      t("field.duration"),
      [lengthControl.element, unit(t("transport.unitSeconds"))],
      t("transport.durationTip"),
    ),
    group(t("transport.fps"), [fpsControl.element], t("transport.fpsTip")),
    restart.element,
  ]);

  const syncSettings = (): void => {
    lengthControl.setValue(duration());
    fpsControl.setValue(fps());
  };
  // Only swap the play glyph when the *state* changes, not every tick - swapping it mid-click would
  // tear out the SVG under the pointer, so a second press never lands as a `click`.
  let shownPlaying: boolean | undefined = undefined;
  const updateTransport = (): void => {
    const playing = transport.isPlaying();
    if (playing !== shownPlaying) {
      shownPlaying = playing;
      play.replaceChildren(icon(playing ? controlIcons.pause : controlIcons.play));
      play.classList.toggle("timeline__transport-btn--active", playing);
    }
  };

  transport.subscribe(updateTransport);
  signals.on("sourceViewChanged", syncSettings);
  signals.on("sourceStructureChanged", syncSettings);
  syncSettings();
  updateTransport();

  return element;
}

/** Nudges the playhead by whole frames, clamped at the timeline start. */
function stepFrame(store: Store, transport: TransportStore, delta: number): void {
  const fps = store.getSource().timeline.fps;
  const frame = frameOf(transport.getTime(), fps);
  transport.seek(timeOfFrame(Math.max(0, frame + delta), fps));
}

function group(label: string, controls: HTMLElement[], tooltip: string): HTMLElement {
  const element = createElement("div", { className: "timeline__group" }, [
    createElement("span", { className: "timeline__group-label", textContent: label }),
    ...controls,
  ]);
  attachTooltip(element, label, tooltip);
  return element;
}

function unit(text: string): HTMLElement {
  return createElement("span", { className: "timeline__unit", textContent: text });
}

function transportButton(glyph: string, title: string, description: string): HTMLButtonElement {
  const button = createElement("button", {
    className: "timeline__transport-btn",
  });
  button.type = "button";
  button.append(icon(glyph));
  attachTooltip(button, title, description);
  // Don't take focus on click: a focused play button would both activate on Space *and* fire the
  // transport hotkey - two toggles that cancel out.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}
