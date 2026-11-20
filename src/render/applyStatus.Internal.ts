/** Apply statuses shared by the emitter and mesh views. */

import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import { t } from "../i18n";
import { compilerErrorMessage } from "../i18n/compilerErrors";
import type { LiveApplyStatus } from "../model/editorState";

export const RECOMPILED: LiveApplyStatus = { status: "recompiled", messages: [] };
export const REBOUND: LiveApplyStatus = { status: "rebound", messages: [] };

export function invalid(messages: readonly string[]): LiveApplyStatus {
  return { status: "invalid", messages };
}

/** An invalid status that carries the node-attributed problems, so the canvas can highlight them. */
export function invalidFromErrors(errors: readonly FXCompilerError[]): LiveApplyStatus {
  return {
    status: "invalid",
    messages: errors.map((error) => compilerErrorMessage(error)),
    errors,
  };
}

export function withWarnings(
  status: LiveApplyStatus,
  warnings: readonly FXCompilerError[],
): LiveApplyStatus {
  return warnings.length === 0 || status.status === "invalid"
    ? status
    : { ...status, warnings: warnings.map((warning) => compilerErrorMessage(warning)) };
}

/**
 * `status` failed when the renderer could not link the program the graph produced: `log` is the
 * first line of the driver's log. A status that already failed stays as it is.
 */
export function withLinkFailure(status: LiveApplyStatus, log: string | undefined): LiveApplyStatus {
  return log === undefined || status.status === "invalid"
    ? status
    : invalid([t("graph.programLinkFailed", { log })]);
}

/** A graph held back only because another graph of the same emitter is invalid. */
export function blocked(): LiveApplyStatus {
  return { status: "invalid", messages: [t("graph.blockedByOtherGraph")] };
}
