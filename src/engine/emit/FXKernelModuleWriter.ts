import type { FXFusedProgramStandard } from "../behavior/FXKernelBuildStandard.Internal";
import type { FXGLSLHelperName } from "../core/ir/FXHelpers.Internal";
import {
  collectKernelHelpers,
  gpuKernelArtifactBody,
  kernelLineLiterals,
} from "./artifactLiterals";
import { lineDeltaLiteral } from "./lineDelta";

/** A kernel written so far: its constant, and the lines constant its vertex source is joined from. */
interface FXWrittenKernel {
  readonly name: string;
  readonly linesName: string;
  /** The element expressions of its lines (see `kernelLineLiterals`). */
  readonly lines: readonly string[];
  readonly fragmentSource: string;
}

/**
 * Writes the GPU (transform-feedback) kernels of one emitted module, so it carries their shared
 * GLSL once: the kernels of a module differ in their bodies, not in the fixed contract uniforms
 * and the shape of `main`. Each kernel's vertex source is joined, when the module loads, from a
 * constant of its lines, which take the lines of the most alike kernel written before where they
 * agree; a helper is named, imported from `sparcoon/helpers` (see {@link helperNames}); a fragment
 * source written before is named, not repeated.
 */
export class FXKernelModuleWriter {
  private readonly written: FXWrittenKernel[] = [];
  private readonly helpers = new Set<FXGLSLHelperName>();

  /** The helpers every kernel written so far links, for the module to import. */
  public helperNames(): readonly FXGLSLHelperName[] {
    return [...this.helpers];
  }

  /** The declarations of kernel `name`: its lines constant, then the kernel itself. */
  public declarations(name: string, program: FXFusedProgramStandard): string[] {
    const lines = kernelLineLiterals(program);
    const linesName = `${name}Lines`;
    const plain = `[${lines.join(", ")}]`;
    for (const helper of collectKernelHelpers(program)) {
      this.helpers.add(helper);
    }
    const shortest = this.written.reduce((best, earlier) => {
      const shared = lineDeltaLiteral(lines, earlier.lines, earlier.linesName);
      return shared.length < best.length ? shared : best;
    }, plain);
    const sameFragment = this.written.find(
      (earlier) => earlier.fragmentSource === program.fragmentSource,
    );
    this.written.push({ name, linesName, lines, fragmentSource: program.fragmentSource });
    return [
      `const ${linesName} = ${shortest};`,
      `const ${name}: FXParticleKernelArtifact = ${gpuKernelArtifactBody(program, {
        vertexSource: `${linesName}.join("\\n")`,
        fragmentSource:
          sameFragment === undefined
            ? JSON.stringify(program.fragmentSource)
            : `${sameFragment.name}.fragmentSource`,
      })};`,
    ];
  }
}
