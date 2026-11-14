/**
 * One kind of particle event of an `EmitterView`, forwarded from whichever emitter runs it now:
 * the view's own listeners stay across rebuilds, and the running emitter is listened to only while
 * there are any and it can report events.
 */

import type { FXEmitter, FXParticleEventKind, FXParticleEventListener } from "sparcoon/editor";

export class ParticleEventForward {
  private readonly listeners = new Set<FXParticleEventListener>();
  private detach: (() => void) | undefined = undefined;

  constructor(private readonly kind: FXParticleEventKind) {}

  /**
   * Attaches `listener`, listening to `emitter` (the running one) if this is the first.
   * @returns Detaches it; the last one stops listening to the running emitter.
   */
  public listen(listener: FXParticleEventListener, emitter: FXEmitter | undefined): () => void {
    this.listeners.add(listener);
    this.attach(emitter);
    return (): void => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) {
        this.detach?.();
        this.detach = undefined;
      }
    };
  }

  /** Listens to `emitter`, the one now running: the subscription to the one before went with it. */
  public follow(emitter: FXEmitter | undefined): void {
    this.detach = undefined;
    this.attach(emitter);
  }

  /** Drops every listener; the running emitter goes with the view. */
  public clear(): void {
    this.listeners.clear();
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
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  };
}
