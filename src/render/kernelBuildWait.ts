/**
 * The GPU kernel program an `EmitterView`'s next rebuild runs, sent off to build while the running
 * emitter goes on. The rebuild waits for it only while waiting saves a stall: the program builds
 * and the context can tell when it is done.
 */

import type { FXParticleKernelArtifact } from "sparcoon";
import { type FXKernelPreparation, fxPrepareKernel } from "sparcoon/editor";
import type { WebGLRenderer } from "three";

export class KernelBuildWait {
  /** The claim on the program the next rebuild runs; `undefined` when there is none. */
  private preparation: FXKernelPreparation | undefined = undefined;
  /** Whether {@link takeEnded} reported the end of this build already. */
  private reported = false;

  constructor(private readonly renderer: WebGLRenderer) {}

  /**
   * Claims `kernel`'s program, sending it off to build unless it is built, and says whether the
   * rebuild should wait for it. Claimed before the previous claim is let go, so a kernel that did
   * not change keeps its program. A kernel the context cannot send off (a lost context) is not
   * waited for: the rebuild falls back to the CPU simulation as `FXEmitter.fromArtifacts` decides.
   */
  public waitsFor(kernel: FXParticleKernelArtifact): boolean {
    let preparation: FXKernelPreparation | undefined;
    try {
      preparation = fxPrepareKernel(this.renderer, kernel);
    } catch {
      preparation = undefined;
    }
    this.release();
    this.preparation = preparation;
    return preparation?.building ?? false;
  }

  /** Whether the build a rebuild waits for has ended since the last call. Reported once per build. */
  public takeEnded(): boolean {
    if (this.preparation === undefined || this.reported || this.preparation.building) {
      return false;
    }
    this.reported = true;
    return true;
  }

  /** Lets the claim go: once the emitter built from the kernel holds its own, or nothing waits. */
  public release(): void {
    this.preparation?.release();
    this.preparation = undefined;
    this.reported = false;
  }
}
