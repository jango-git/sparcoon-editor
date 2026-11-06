/**
 * The one error type the agent API throws. The code is folded into the message as well, because a
 * headless driver (`page.evaluate`) usually only sees an error's message, not its fields.
 */

export type AgentErrorCode =
  /** A referenced owner, node, socket, event, asset or preset does not exist. */
  | "not_found"
  /** An argument is malformed or not allowed for this target (wrong graph kind, bad size...). */
  | "invalid_argument"
  /** The editor declined the edit (a sink cannot be removed, the last emitter cannot go...). */
  | "rejected"
  /** The project could not be compiled for export. */
  | "compile_failed";

export class AgentError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "AgentError";
  }
}
