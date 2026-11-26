/**
 * The viewport camera's view, shared by the viewport (which moves the camera and reports where it
 * is), the Camera tab and the project file. The last view is kept in localStorage, so a reload
 * opens where the camera was. Never part of the document or its undo history.
 */

import { Ferrsign1 } from "ferrsign";

import { readViewportView, type ViewportView } from "../model/viewportView";
import { createAutosave } from "../persistence/autosave";
import { readJson, writeJson } from "../util/storage";

const STORAGE_KEY = "sparcoon-editor.camera";
const STORE_DELAY_MS = 300;

export class ViewportCamera {
  private current: ViewportView;
  private readonly changed = new Ferrsign1<ViewportView>();
  private readonly requested = new Ferrsign1<ViewportView>();
  private readonly store = createAutosave(
    () => writeJson(STORAGE_KEY, this.current),
    STORE_DELAY_MS,
  );

  constructor(initial: ViewportView) {
    this.current = initial;
  }

  public get view(): ViewportView {
    return this.current;
  }

  /** The view kept from the last session, if any. */
  public static stored(): ViewportView | undefined {
    return readViewportView(readJson(STORAGE_KEY));
  }

  /** Asks the viewport to move the camera to `view`; it reports back where the camera ended up. */
  public request(view: ViewportView): void {
    this.requested.emit(view);
  }

  /** Records where the camera is, from the viewport. */
  public report(view: ViewportView): void {
    this.current = view;
    this.changed.emit(view);
    this.store.schedule();
  }

  public onChange(listener: (view: ViewportView) => void): () => void {
    return this.changed.on(listener);
  }

  public onRequest(listener: (view: ViewportView) => void): () => void {
    return this.requested.on(listener);
  }
}
