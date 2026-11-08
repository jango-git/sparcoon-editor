/**
 * The {@link LiveApplyStatus} values the emitter and mesh views answer an apply with - one place
 * for both, so a status means the same whichever object produced it.
 */

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

/** `status` with `warnings` (as messages) attached - unless there are none, or it already failed. */
export function withWarnings(
  status: LiveApplyStatus,
  warnings: readonly FXCompilerError[],
): LiveApplyStatus {
  return warnings.length === 0 || status.status === "invalid"
    ? status
    : { ...status, warnings: warnings.map((warning) => compilerErrorMessage(warning)) };
}

/** A graph held back only because another graph of the same emitter is invalid. */
export function blocked(): LiveApplyStatus {
  return { status: "invalid", messages: [t("graph.blockedByOtherGraph")] };
}
