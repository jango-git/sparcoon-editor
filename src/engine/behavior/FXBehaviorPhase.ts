/**
 * Execution phase of a behavior node - the analog of {@link FXShaderStage} for render.
 * SPAWN runs once at birth (initial state); UPDATE runs every frame.
 */
export enum FXBehaviorPhase {
  SPAWN = "spawn",
  UPDATE = "update",
}
