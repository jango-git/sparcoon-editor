import { FXCompilerErrorException } from "../compiler/FXCompilerError";

/**
 * Guards a manual node's structural-only params (attribute name/type, stage/phase, ...):
 * constructor-only, so a snapshot changing one under a stable id is rejected loudly
 * instead of silently ignored - editor contract is structural edit = new node id.
 */
export function checkStructuralParam(
  parameters: Readonly<Record<string, unknown>>,
  key: string,
  current: string | boolean,
  allowed?: readonly (string | boolean)[],
): void {
  const value = parameters[key];
  if (value === undefined) {
    return;
  }
  if (allowed !== undefined && !allowed.includes(value as string | boolean)) {
    const allowedList = allowed.map((option) => JSON.stringify(option)).join(", ");
    const got = JSON.stringify(value);
    throw new FXCompilerErrorException({
      code: "bad-structural-param-value",
      message: `param "${key}" must be one of ${allowedList}; got ${got}`,
      params: { key, allowed: allowedList, got },
    });
  }
  if (value !== current) {
    throw new FXCompilerErrorException({
      code: "structural-param-immutable",
      message: `structural param "${key}" of a manual node cannot change under a stable id - recreate the node with a new id`,
      params: { key },
    });
  }
}
