import * as ts from "typescript";
import * as three from "three";
import * as sparcoon from "sparcoon";

/** What an emitted project module may import: the real `three` and `sparcoon`. */
const PROJECT_IMPORTS: Readonly<Record<string, unknown>> = { three, sparcoon };

/**
 * Transpiles emitted TS module text to CJS and evaluates it, returning its exports - the runtime
 * path a consumer gets, minus the bundler. `imports` is all it may import; any other import throws.
 */
export function loadModule(
  text: string,
  imports: Readonly<Record<string, unknown>> = PROJECT_IMPORTS,
): Record<string, unknown> {
  const js = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const shimModule = { exports: {} as Record<string, unknown> };
  const shimRequire = (id: string): unknown => {
    if (!Object.hasOwn(imports, id)) {
      throw new Error(`unexpected import ${JSON.stringify(id)}`);
    }
    return imports[id];
  };
  new Function("require", "exports", "module", js)(shimRequire, shimModule.exports, shimModule);
  return shimModule.exports;
}
