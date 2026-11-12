import type { FXFusedProgramStandard } from "../behavior/FXKernelBuildStandard.Internal";
import { gpuKernelArtifactBody } from "./artifactLiterals";
import { lineDeltaLiteral } from "./lineDelta";

/** A kernel written so far: its constant, and the lines constant its vertex source is joined from. */
interface FXWrittenKernel {
  readonly name: string;
  readonly linesName: string;
  readonly lines: readonly string[];
  readonly fragmentSource: string;
}

/**
 * Writes the GPU (transform-feedback) kernels of one emitted module, so it carries their shared
 * GLSL once: the kernels of a module differ in their bodies, not in the fixed contract uniforms,
 * the hash helpers and the shape of `main`. Each kernel's vertex source is joined, when the module
 * loads, from a constant of its lines, which take the lines of the most alike kernel written
 * before where they agree; a fragment source written before is named, not repeated.
 */
export class FXKernelModuleWriter {
  private readonly written: FXWrittenKernel[] = [];

  /** The declarations of kernel `name`: its lines constant, then the kernel itself. */
  public declarations(name: string, program: FXFusedProgramStandard): string[] {
    const lines = program.vertexSource.split("\n");
    const linesName = `${name}Lines`;
    const plain = JSON.stringify(lines);
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
