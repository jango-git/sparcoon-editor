import type { FXFusedProgramStandard } from "../behavior/FXKernelBuildStandard.Internal";
import type { FXGLSLHelperName } from "../core/ir/FXHelpers.Internal";
import {
  collectKernelHelpers,
  gpuKernelArtifactBody,
  kernelLineLiterals,
} from "./artifactLiterals";
import { lineDeltaLiteral } from "./lineDelta";

interface FXWrittenKernel {
  readonly name: string;
  readonly linesName: string;
  readonly lines: readonly string[];
  readonly fragmentSource: string;
}

/**
 * Writes the GPU kernels of a module. Each kernel reuses lines of the most alike earlier kernel,
 * helpers are imported, and an earlier fragment source is named, not repeated.
 */
export class FXKernelModuleWriter {
  private readonly written: FXWrittenKernel[] = [];
  private readonly helpers = new Set<FXGLSLHelperName>();

  public helperNames(): readonly FXGLSLHelperName[] {
    return [...this.helpers];
  }

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
