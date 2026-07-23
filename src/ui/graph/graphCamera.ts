/**
 * Frame-to-fit for the node canvas whenever the shown graph changes. Switching graphs - between
 * objects, or between an object's render / behavior graphs - re-centres on the whole graph, the
 * same gesture as the "f" hotkey. No per-graph pan/zoom is remembered across switches.
 *
 * "Frame on open" is deferred: the canvas measures 0x0 while its tab is hidden or mid-load, so a
 * requested frame is held (see {@link requestFrame}) until a later frame / resize finds a real size.
 * Which nodes to frame (selection vs the whole graph) is the caller's injected `frame` callback.
 */

export class GraphCamera {
  /** The graph the viewport currently shows (its `${emitterId}:${mode}` key), to know when it swaps. */
  private cameraKey: string | undefined;
  private pendingFrame = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly frame: () => void,
  ) {}

  /** Frames the graph when `key` names a different graph than the one on screen. */
  public switchTo(key: string): void {
    if (key === this.cameraKey) {
      return;
    }
    this.cameraKey = key;
    this.requestFrame();
  }

  /** Requests a frame-to-fit once the canvas has a measurable layout (see {@link maybeFrame}). */
  public requestFrame(): void {
    this.pendingFrame = true;
    requestAnimationFrame(() => this.maybeFrame());
  }

  /**
   * Consumes a pending "frame on open" request, but only once the canvas has a real size - while
   * the graph tab is hidden or mid-load it measures 0x0, so the request is held for a later call.
   */
  public maybeFrame(): void {
    if (!this.pendingFrame) {
      return;
    }
    const bounds = this.root.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) {
      return;
    }
    this.pendingFrame = false;
    this.frame();
  }
}
