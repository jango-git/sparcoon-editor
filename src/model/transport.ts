/**
 * The timeline transport: playhead position + play/pause state. Transient like the preview
 * settings/camera - playback chrome, never in the model/history/saved doc; `TimelineDispatcher` reads `time` each tick to drive spawns and values into the running emitter.
 */

export type TransportListener = () => void;

export class TransportStore {
  private time = 0;
  private playing = false;
  private frameHandle: number | undefined = undefined;
  private lastTimestamp: number | undefined = undefined;
  private restartOnRebuildFlag = true;
  private readonly listeners = new Set<TransportListener>();

  /**
   * @param duration Accessor for the authored timeline length (seconds); read every tick.
   * @param infinite Accessor for whether the timeline is infinite (an infinite play event exists):
   *   playback then parks the caret at the last frame instead of looping (task 2).
   */
  constructor(
    private readonly duration: () => number,
    private readonly infinite: () => boolean = () => false,
  ) {}

  /** Whether a structural rebuild should restart the timeline (rewind to 0). Editor preference. */
  public get restartOnRebuild(): boolean {
    return this.restartOnRebuildFlag;
  }

  /** Whether the timeline is currently infinite (drives the caret colour + park-at-end behaviour). */
  public isInfinite(): boolean {
    return this.infinite();
  }

  public setRestartOnRebuild(value: boolean): void {
    this.restartOnRebuildFlag = value;
  }

  /** The playhead position in seconds, always within `[0, duration]`. */
  public getTime(): number {
    return this.time;
  }

  public isPlaying(): boolean {
    return this.playing;
  }

  /** Starts (or resumes) playback from the current playhead. No-op while already playing. */
  public play(): void {
    if (this.playing) {
      return;
    }
    this.playing = true;
    this.lastTimestamp = undefined;
    this.frameHandle = requestAnimationFrame((timestamp) => this.tick(timestamp));
    this.notify();
  }

  /** Freezes the playhead where it is. */
  public pause(): void {
    if (!this.playing) {
      return;
    }
    this.stopTicking();
    this.notify();
  }

  /** Stops and rewinds the playhead to the start. */
  public stop(): void {
    const wasPlaying = this.playing;
    this.stopTicking();
    const changed = this.time !== 0;
    this.time = 0;
    if (wasPlaying || changed) {
      this.notify();
    }
  }

  /**
   * Rewinds to the start, preserving play state (still playing keeps playing, from 0). Used on a
   * structural rebuild so live editing replays the effect without interrupting playback.
   */
  public restart(): void {
    const wasPlaying = this.playing;
    // stop() rewinds to 0 and (while stopped) lets listeners clear live particles; if we were
    // playing, resume immediately so the effect replays from the top without a gap.
    this.stop();
    if (wasPlaying) {
      this.play();
    }
  }

  /** Moves the playhead to `time`, clamped to `[0, duration]`. Does not change play state. */
  public seek(time: number): void {
    const clamped = clamp(time, 0, Math.max(0, this.duration()));
    if (clamped === this.time) {
      return;
    }
    this.time = clamped;
    this.notify();
  }

  /** Subscribes to playhead/state changes; returns an unsubscribe. */
  public subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private tick(timestamp: number): void {
    if (!this.playing) {
      return;
    }
    const duration = this.duration();
    if (this.lastTimestamp !== undefined && duration > 0) {
      const deltaTime = (timestamp - this.lastTimestamp) / 1000;
      // An infinite timeline parks the caret at the last frame while the sim (gated on isPlaying,
      // not the caret) keeps running past it (task 2); otherwise loop back to the start.
      this.time = this.infinite()
        ? Math.min(this.time + deltaTime, duration)
        : (this.time + deltaTime) % duration;
    }
    this.lastTimestamp = timestamp;
    this.notify();
    this.frameHandle = requestAnimationFrame((next) => this.tick(next));
  }

  private stopTicking(): void {
    this.playing = false;
    this.lastTimestamp = undefined;
    if (this.frameHandle !== undefined) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = undefined;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
