/**
 * Frames the whole graph whenever the shown graph changes. Framing is deferred while the canvas
 * measures 0x0 (hidden tab or loading). The caller supplies the `frame` callback.
 */

export class GraphCamera {
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
