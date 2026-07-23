import type { FXCompilerErrorCode } from "./FXCompilerError";
import { FXCompilerErrorException } from "./FXCompilerError";

/**
 * Normalizes a build-time throw into an {@link FXCompilerErrorException} carrying the node's id,
 * so a code-gen-only failure (audit-3 M4) is node-attributed instead of an untagged crash.
 */
export function tagNodeBuildError(
  error: unknown,
  nodeId: string,
  code: FXCompilerErrorCode = "compile-failed",
): FXCompilerErrorException {
  if (error instanceof FXCompilerErrorException) {
    return error.error.nodeId === undefined
      ? new FXCompilerErrorException({ ...error.error, nodeId })
      : error;
  }
  return new FXCompilerErrorException({
    code,
    message: error instanceof Error ? error.message : String(error),
    nodeId,
  });
}
