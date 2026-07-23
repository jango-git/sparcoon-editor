import { FXCompilerErrorException } from "../compiler/FXCompilerError";

/** Validates a finite scalar (optionally within `[min, max]`), throwing `bad-param`-style; returns it. */
export function finiteScalar(where: string, raw: unknown, min?: number, max?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new FXCompilerErrorException({
      code: "bad-finite-number",
      message: `FXNodeDefinition: ${where} expects a finite number`,
      params: { where },
    });
  }
  if ((min !== undefined && raw < min) || (max !== undefined && raw > max)) {
    const minText = min ?? "-inf";
    const maxText = max ?? "+inf";
    throw new FXCompilerErrorException({
      code: "bad-finite-number-range",
      message: `FXNodeDefinition: ${where} must be within [${minText}, ${maxText}]`,
      params: { where, min: minText, max: maxText },
    });
  }
  return raw;
}

/** Validates a fixed-`width` vector of finite numbers; returns a defensive copy. */
export function finiteVector(where: string, raw: unknown, width: number): readonly number[] {
  if (
    !Array.isArray(raw) ||
    raw.length !== width ||
    !raw.every((component) => typeof component === "number" && Number.isFinite(component))
  ) {
    throw new FXCompilerErrorException({
      code: "bad-finite-vector",
      message: `FXNodeDefinition: ${where} expects ${width.toString()} finite numbers`,
      params: { where, width },
    });
  }
  return (raw as number[]).slice();
}

/**
 * Validates a finite scalar or 1-4 component vector, no fixed width - for a generic `"T"`
 * editable input with no sibling `valueType` hint (e.g. `binary-op`'s `a`/`b`), whose true
 * width is only known from the graph at build time (`editableInputLiteral` pads/truncates it).
 */
export function finiteScalarOrVector(where: string, raw: unknown): number | readonly number[] {
  if (typeof raw === "number") {
    return finiteScalar(where, raw);
  }
  if (
    Array.isArray(raw) &&
    raw.length >= 1 &&
    raw.length <= 4 &&
    raw.every((component) => typeof component === "number" && Number.isFinite(component))
  ) {
    return raw.slice();
  }
  throw new FXCompilerErrorException({
    code: "bad-finite-scalar-or-vector",
    message: `FXNodeDefinition: ${where} expects a finite number or a 1-4 component vector`,
    params: { where },
  });
}
