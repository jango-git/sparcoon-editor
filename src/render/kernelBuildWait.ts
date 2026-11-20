/**
 * Builds the GPU kernel program of the next rebuild in the background and tells the rebuild whether
 * waiting avoids a stall.
 */

import type { FXParticleKernelArtifact } from "sparcoon";
import { type FXKernelPreparation, fxPrepareKernel } from "sparcoon/editor";
import type { WebGLRenderer } from "three";

export class KernelBuildWait {
  private preparation: FXKernelPreparation | undefined = undefined;
  /** Whether {@link takeEnded} reported the end of this build already. */
  private reported = false;

  constructor(private readonly renderer: WebGLRenderer) {}

  /**
   * Claims `kernel`'s program, starting its build if needed. Returns whether the rebuild should
   * wait. The new claim is taken before the old one is released, so an unchanged kernel keeps its
   * program. A kernel the context cannot build (lost context) is not waited for.
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
