/**
 * One kind of particle event of an `EmitterView`, forwarded from whichever emitter runs it now:
 * the view's own listeners stay across rebuilds, and the running emitter is listened to only while
 * there are any and it can report events.
 */

import type { FXEmitter, FXParticleEventKind, FXParticleEventListener } from "sparcoon/editor";

export class ParticleEventForward {
  private readonly listeners = new Set<FXParticleEventListener>();
  // The listeners an event goes to, taken again only after they change: an event reaches those
  // attached when it arrives, however its listeners attach or detach.
  private snapshot: readonly FXParticleEventListener[] | undefined = undefined;
  private detach: (() => void) | undefined = undefined;

  constructor(private readonly kind: FXParticleEventKind) {}

  /**
   * Attaches `listener`, listening to `emitter` (the running one) if this is the first.
   * @returns Detaches it; the last one stops listening to the running emitter.
   */
  public listen(listener: FXParticleEventListener, emitter: FXEmitter | undefined): () => void {
    this.listeners.add(listener);
    this.snapshot = undefined;
    this.attach(emitter);
    return (): void => {
      this.snapshot = undefined;
      if (this.listeners.delete(listener) && this.listeners.size === 0) {
        this.detach?.();
        this.detach = undefined;
      }
    };
  }

  public follow(emitter: FXEmitter | undefined): void {
    this.detach = undefined;
    this.attach(emitter);
  }

  public clear(): void {
    this.listeners.clear();
    this.snapshot = undefined;
    this.detach = undefined;
  }

  private attach(emitter: FXEmitter | undefined): void {
    if (
      this.detach !== undefined ||
      this.listeners.size === 0 ||
      emitter?.reportsParticleEvents !== true
    ) {
      return;
    }
    this.detach = emitter.onParticleEvent(this.kind, this.forward);
  }

  private readonly forward: FXParticleEventListener = (event) => {
    this.snapshot ??= [...this.listeners];
    for (const listener of this.snapshot) {
      listener(event);
    }
  };
}
