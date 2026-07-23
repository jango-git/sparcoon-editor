/** Composition root: wires the layers UI -> command -> model -> event -> render; store+signals is the single source of truth. */

import { Vector2 } from "three";
import { Pipeline } from "./model/pipeline";
import { insertTransformKeyframes } from "./model/commands";
import { snapTimeToFrame } from "./model/frames";
import { TRANSFORM_CHANNELS } from "./model/transform";
import { VFX_ENTITY } from "./model/entity";
import { hasInfinitePlay, selectActiveGraphOwner } from "./model/selectors";
import { SelectionStore } from "./model/selectionStore";
import { commitEntitySelection } from "./ui/selection";
import { SignalBus } from "./model/signals";
import { Store } from "./model/store";
import { TransportStore } from "./model/transport";
import { GizmoSettingsStore } from "./settings/gizmoSettings";
import { createAutosave } from "./persistence/autosave";
import { saveSource } from "./persistence/localStore";
import { loadInitialState } from "./persistence/loadState";
import { PreviewSettingsStore } from "./settings/previewSettings";
import { detectRenderBackend } from "./settings/renderBackend";
import { initTheme } from "./settings/theme";
import { getLocale, initI18n } from "./i18n";
import { SceneEmitters } from "./render/sceneEmitters";
import { SceneCoordinator } from "./render/sceneCoordinator";
import { EnvironmentTextureRegistry, type DecodedEnvironment } from "./render/environmentTexture";
import { TimelineDispatcher } from "./render/timelineDispatcher";
import { TextureRegistry } from "./render/textureRegistry";
import { MeshGeometryRegistry } from "./render/meshGeometryRegistry";
import { mountApplicationShell } from "./ui/appShell";
import type { EditorContext } from "./ui/editorContext";
import { EditorPanel } from "./ui/focus/panelFocus";
import { HotkeyRouter } from "./ui/focus/hotkeyRouter";
import { PanelFocus } from "./ui/focus/panelFocus";
import { PanelFocusTracker } from "./ui/focus/panelFocusTracker";
import { installHotkeys } from "./ui/hotkeys";
import { InputMode, InputModeState } from "./ui/inputMode";
import { installPreviewContextMenu } from "./ui/tools/previewContextMenu";
import { TransformTool } from "./ui/tools/transformTool";
import { TransformGuides } from "./render/transformGuides";

async function bootstrap(): Promise<void> {
  const root = document.getElementById("application") ?? undefined;
  if (root === undefined) {
    throw new Error("Missing #application root element");
  }

  // Re-apply the persisted theme and start tracking OS changes while in auto mode. The
  // inline <head> script already set data-theme before paint; this keeps it live.
  initTheme();

  // Locale dictionaries are fetched, not bundled; load the active locale (and the English
  // fallback) before anything builds UI that calls t(). Reflect the choice on <html lang>.
  await initI18n();
  document.documentElement.lang = getLocale();

  // Right-click is a tool gesture (pan/orbit/menu) across the editor, so the native context menu
  // is suppressed app-wide; listening on `document` also covers menus mounted outside the app root.
  document.addEventListener("contextmenu", (event) => event.preventDefault());

  // Tab focus traversal is noise in a pointer-driven editor, so it's suppressed everywhere except
  // inside a text field; capture phase so this wins before any widget's own handler.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Tab") {
        return;
      }
      const target = event.target;
      const editable =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement);
      if (!editable) {
        event.preventDefault();
      }
    },
    true,
  );

  const initialState = await loadInitialState();
  const signals = new SignalBus();
  const store = new Store(initialState, signals);

  const previewSettings = new PreviewSettingsStore();
  // The timeline transport is transient (playhead + play state); it loops over the authored
  // length in `source.timeline`, read live so the length command takes effect immediately.
  const transport = new TransportStore(
    () => store.getSource().timeline.duration,
    () => hasInfinitePlay(store),
  );
  // The caret time snapped to its frame - the timeline is frame-stepped, so every transform
  // re-pose (rebuild, view edit, transport drive) samples at the same frame the caret sits on.
  const frameTime = (): number =>
    snapTimeToFrame(transport.getTime(), store.getSource().timeline.fps);

  // Which workspace panel the pointer is over drives both the accent ring and the keymap the
  // hotkey router applies. The tracker sets it from the cursor; the router reads it live.
  const panelFocus = new PanelFocus();
  const panelFocusTracker = new PanelFocusTracker(panelFocus);
  const router = new HotkeyRouter(panelFocus);
  // Which entity the preview gizmo / hotkeys target; transient editor focus like the transport,
  // seeded from the document's active graph owner so a reload's highlight matches the restored graph.
  const timelineSelection = new SelectionStore();
  {
    const owner = selectActiveGraphOwner(store);
    if (owner.kind === "vfxMesh") {
      timelineSelection.selectVfxMesh(owner.id);
    } else {
      timelineSelection.selectEmitter(owner.id);
    }
  }
  // Gizmo preferences: axis space (Local/Global) + per-mode snap increments.
  const gizmoSettings = new GizmoSettingsStore();
  // How the editor is navigated (mouse vs trackpad) - one global state read by the graph and the
  // viewport, set from the middlebar toggle (tasks 11-12).
  const inputMode = new InputModeState();
  const context: EditorContext = {
    store,
    signals,
    transport,
    router,
    panelFocus,
    panelFocusTracker,
    selection: timelineSelection,
    inputMode,
    previewSettings,
    gizmoSettings,
  };
  const shell = mountApplicationShell(root, context);

  // Fixed for the session (settings/renderBackend.ts): the preview's own switch persists a
  // change and reloads, rather than swapping the renderer/compiler live.
  const renderBackend = detectRenderBackend();
  const coordinator = new SceneCoordinator(
    shell.canvas,
    shell.previewContainer,
    previewSettings,
    renderBackend,
    () => transport.isPlaying(),
    shell.reportStats,
  );
  // Viewport navigation follows the global input mode (task 12): touchpad pans on two-finger
  // scroll and pinch-zooms; mouse keeps the wheel-zoom.
  const applyInputMode = (): void => coordinator.setTouchpad(inputMode.mode === InputMode.Touchpad);
  inputMode.onChange(applyInputMode);
  applyInputMode();
  // The texture registry turns the asset library's data-URL images into live GPU textures
  // the preview binds into its Texture slots. A finished async decode rebinds.
  const textures = new TextureRegistry(() => pipeline.scheduleRecompute());
  // ADR-0004: HDRI decode drives the viewport background + light probe. `derivedSunFor` re-derives
  // Sun only once per (re)activation, so a manual Sun edit under HDRI isn't silently overwritten again.
  let derivedSunFor: DecodedEnvironment | undefined;
  function applyActiveEnvironment(): void {
    const decoded = environments.resolve(previewSettings.get().activeEnvironmentName);
    if (decoded === undefined) {
      derivedSunFor = undefined;
    } else if (decoded !== derivedSunFor) {
      derivedSunFor = decoded;
      previewSettings.update({
        sun: decoded.sun.enabled,
        sunColor: decoded.sun.color,
        sunIntensity: decoded.sun.intensity,
        sunAzimuth: decoded.sun.azimuth,
        sunElevation: decoded.sun.elevation,
      });
    }
    coordinator.setActiveEnvironment(decoded);
  }
  const environments = new EnvironmentTextureRegistry(applyActiveEnvironment);
  previewSettings.subscribe(applyActiveEnvironment);
  // Mesh-geometry registry turns baked mesh assets into live BufferGeometry for "custom" geometry
  // sources; fully synchronous (no decode), so unlike TextureRegistry it needs no load-callback.
  const meshGeometries = new MeshGeometryRegistry();
  const sceneEmitters = new SceneEmitters(
    coordinator.scene,
    (name) => textures.resolve(name),
    coordinator.getCamera(),
    coordinator.getRenderer(),
    renderBackend,
    frameTime,
    () => meshGeometries.resolveAll(),
  );
  // The FPS readout reports the live particle count alongside it; wire the source now that the
  // scene emitters exist (before the first frame).
  coordinator.setParticleCountSource(() => sceneEmitters.totalParticleCount());
  // Restart the timeline only on a genuine rebuild (never a value-only rebind, e.g. a timeline-
  // value edit), and keep playing from the top so a live structural edit needs no replay tap.
  const pipeline = new Pipeline(store, sceneEmitters, () => {
    if (transport.restartOnRebuild) {
      transport.restart();
    }
  });
  // The timeline drives spawning: crossing a burst/play event fires it on the owning emitter.
  new TimelineDispatcher(
    store,
    transport,
    sceneEmitters,
    () => store.getSource().timeline.duration,
  );

  // Model -> render: sync texture/mesh caches before the coalesced recompute reads them;
  // autosave follows every commit, saving only source, flushed before the tab goes away.
  const autosave = createAutosave(() => saveSource(store.getSource()));
  window.addEventListener("pagehide", () => autosave.flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      autosave.flush();
    }
  });
  signals.on("sourceStructureChanged", () => textures.sync(store.getSource().assets));
  signals.on("sourceStructureChanged", () => meshGeometries.sync(store.getSource().meshAssets));
  signals.on("sourceStructureChanged", () => pipeline.scheduleRecompute());
  signals.on("sourceStructureChanged", () => autosave.schedule());
  signals.on("sourceViewChanged", () => autosave.schedule());
  // Environment-library edits commit as "view" (they feed no compiled graph) and undo/redo now
  // re-announces the original kind, so "view" alone covers every environment edit.
  signals.on("sourceViewChanged", () => environments.sync(store.getSource().environments));
  // A view-only transform edit (gizmo commit / inspector field / transform keyframe) never
  // recompiles, so it doesn't run the pipeline - re-pose the scene directly at the caret.
  signals.on("sourceViewChanged", () =>
    sceneEmitters.applySceneTransforms(store.getSource().scene, frameTime()),
  );
  // Highlight the selected entity's preview gizmo, and keep it lit across rebuilds.
  sceneEmitters.setSelected(timelineSelection.get());
  timelineSelection.subscribe(() => sceneEmitters.setSelected(timelineSelection.get()));
  // Follow the document's active graph owner with the transient selection (add/remove/switch can
  // move it out from under the selection); the VFX group has no id, so its own pick stays sticky.
  signals.on("sourceStructureChanged", () => {
    const selected = timelineSelection.get();
    if (selected.kind === "vfx") {
      return;
    }
    // The one existence-checked resolver both this and the graph canvas read, so the gizmo/timeline
    // highlight can't diverge from the graph-edited object (a just-removed mesh falls back too).
    const owner = selectActiveGraphOwner(store);
    if (owner.kind === "vfxMesh") {
      if (!(selected.kind === "vfxMesh" && selected.id === owner.id)) {
        timelineSelection.selectVfxMesh(owner.id);
      }
    } else if (selected.kind === "vfxMesh" || selected.id !== owner.id) {
      timelineSelection.selectEmitter(owner.id);
    }
  });

  installHotkeys(router, store, transport);
  // Ctrl+Space opens the Content screen from any panel, alongside the middlebar's own button -
  // plain Space stays the Viewport/Timeline transport play/pause (transportKeymap in hotkeys.ts),
  // since the router's modifier match keeps the two chords distinct.
  router.registerGlobal([{ code: "Space", modifier: true, run: (): void => shell.openAssets() }]);

  // The Blender-style modal transform tool (grab/rotate/scale) for the selected entity. G/R/S
  // start it while the Viewport is the active panel; the tool then owns the pointer + keys.
  const transformGuides = new TransformGuides(coordinator.scene);
  const transformTool = new TransformTool(
    coordinator.getCamera(),
    shell.canvas,
    transformGuides,
    (enabled) => coordinator.setControlsEnabled(enabled),
    sceneEmitters,
    context,
  );
  // Frames the selected object (or the whole VFX scene) in the viewport.
  const focusSelected = (): void => {
    const entity = timelineSelection.get();
    const object = sceneEmitters.entityObject(entity) ?? sceneEmitters.entityObject(VFX_ENTITY);
    if (object !== undefined) {
      coordinator.focusOn(object, entity.kind === "vfx" ? 6 : 2);
    }
  };
  router.registerPanel(EditorPanel.Viewport, [
    // Blender-style overlay toggle while the viewport is active: N collapses/expands the N-panel's
    // active tab (the side tab strip stays visible).
    { code: "KeyN", run: (): void => shell.toggleTransformPanel() },
    { code: "KeyG", shift: false, run: (): void => transformTool.begin("grab") },
    { code: "KeyR", shift: false, run: (): void => transformTool.begin("rotate") },
    { code: "KeyS", shift: false, run: (): void => transformTool.begin("scale") },
    { code: "KeyF", shift: false, run: focusSelected },
    // I bakes a keyframe for every transform channel of the selected object at the playhead.
    {
      code: "KeyI",
      run: (): void =>
        insertTransformKeyframes(
          store,
          timelineSelection.get(),
          transport.getTime(),
          TRANSFORM_CHANNELS,
        ),
    },
  ]);
  // Left-click (no drag) picks via raycast (task 9); a moved pointer (orbit) or the modal transform
  // tool owning the pointer both suppress it. Bound on the container so overlay dead-zones still resolve.
  {
    const PICK_THRESHOLD = 4;
    let downX = 0;
    let downY = 0;
    // A press begun on a bubbling overlay (the tab strip) orbits but must not also select through it.
    let downOnOverlay = false;
    shell.previewContainer.addEventListener("pointerdown", (event) => {
      downX = event.clientX;
      downY = event.clientY;
      downOnOverlay =
        event.target instanceof Element && Boolean(event.target.closest(".viewport-transform"));
    });
    shell.previewContainer.addEventListener("pointerup", (event) => {
      if (
        event.button !== 0 ||
        downOnOverlay ||
        transformTool.isActive() ||
        Math.abs(event.clientX - downX) > PICK_THRESHOLD ||
        Math.abs(event.clientY - downY) > PICK_THRESHOLD
      ) {
        return;
      }
      const rectangle = shell.canvas.getBoundingClientRect();
      const ndc = new Vector2(
        ((event.clientX - rectangle.left) / rectangle.width) * 2 - 1,
        -((event.clientY - rectangle.top) / rectangle.height) * 2 + 1,
      );
      const entity = sceneEmitters.pick(ndc, coordinator.getCamera());
      if (entity !== undefined) {
        commitEntitySelection(store, timelineSelection, entity);
      }
    });
  }

  // Right-click (no drag) in the preview => insert a position / rotation / scale key separately.
  installPreviewContextMenu(shell.previewContainer, store, timelineSelection, transport, () =>
    transformTool.isActive(),
  );

  coordinator.start();

  // Initial derive: seed the texture caches, then run the source through the library once.
  textures.sync(store.getSource().assets);
  environments.sync(store.getSource().environments);
  pipeline.recomputeNow();
}

void bootstrap();
