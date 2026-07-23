/**
 * Debounces the direction of a mouse-wheel gesture so a single spurious opposite notch (mechanical
 * wheel bounce) does not flip a zoom mid-gesture. A run of >=2 notches one way "arms" the lock; a
 * lone opposite notch after that is forced back to the run's direction. Only a *second* consecutive
 * opposite notch counts as a real reversal and re-arms the lock the new way.
 *
 * Timing is idle-based, not a live timer: state is only read on the next notch, so comparing the
 * caller-supplied timestamp against the previous one is equivalent to a reset timer but stays pure
 * and deterministic. Meant for mouse mode only - the caller gates that; this filter is mode-agnostic.
 */

/** Milliseconds of wheel silence after which the next notch starts a fresh, trusted run. */
const IDLE_RESET_MS = 35;

/** Minimum same-direction run length before a lone opposite notch is treated as spurious. */
const ARM_LENGTH = 2;

export class WheelDirectionLock {
  private lockedDirection: -1 | 1 | undefined;
  private runLength = 0;
  private pendingReversal = false;
  private lastTimestamp = 0;

  /**
   * Returns `deltaY` with its sign corrected to the locked direction when a lone opposite notch is
   * judged spurious; otherwise returns it unchanged. `now` is the event timestamp in ms
   * (`event.timeStamp`); pass a monotonic clock. A zero `deltaY` is passed through untouched.
   */
  public resolve(deltaY: number, now: number): number {
    if (deltaY === 0) {
      return deltaY;
    }
    const rawDirection = deltaY < 0 ? -1 : 1;
    const idle = this.lockedDirection === undefined || now - this.lastTimestamp > IDLE_RESET_MS;
    this.lastTimestamp = now;

    if (idle) {
      this.lockedDirection = rawDirection;
      this.runLength = 1;
      this.pendingReversal = false;
      return deltaY;
    }

    if (rawDirection === this.lockedDirection) {
      this.runLength += 1;
      this.pendingReversal = false;
      return deltaY;
    }

    // Opposite notch. Suppress it as a spurious flip only if the run was armed and this is the
    // first opposite one; a second consecutive opposite notch is a genuine reversal.
    if (this.runLength >= ARM_LENGTH && !this.pendingReversal) {
      this.pendingReversal = true;
      return -deltaY; // force back to the locked direction
    }
    this.lockedDirection = rawDirection;
    this.runLength = 1;
    this.pendingReversal = false;
    return deltaY;
  }
}
