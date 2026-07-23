import type { FXGLSLTypeName, FXValueType } from "../core/socket/FXValueType";
import { NUMERIC_VALUE_TYPES, resolveValueType } from "../core/socket/FXValueType";
import { assertValidAttributeName } from "../core/socket/FXAttribute";

/**
 * Shared support for the named-**param** nodes (`timeline-value` render/behavior, `texture`): a
 * uniform/binding addressed by a stable user name (unlike a baked `constant`), driven live via
 * {@link FXEmitter.applyValues}. The slot name derives deterministically from that name (below).
 */

/** The value types a Timeline Value can carry (the shared numeric value-type set). */
export const PARAM_VALUE_TYPES = NUMERIC_VALUE_TYPES;

/**
 * Resolves a Timeline Value `type` param to its {@link FXValueType}, mapping the UI-only
 * `"color"` alias to `vec4`, exactly like `constant`. Throws on any other non-numeric value.
 */
export function resolveParamType(type: unknown): FXValueType {
  const name = type === "color" ? "vec4" : type;
  if (typeof name !== "string" || !PARAM_VALUE_TYPES.includes(name as FXGLSLTypeName)) {
    throw new Error(
      `timeline-value.type must be one of ${PARAM_VALUE_TYPES.join(", ")} (or "color")`,
    );
  }
  return resolveValueType(name as FXGLSLTypeName);
}

/** Component suffixes for a scalarized vector binding (behavior side). */
export const PARAM_COMPONENTS = ["x", "y", "z", "w"] as const;

/**
 * Validates a user-chosen param name against the attribute-name identifier grammar
 * (`^[a-z][A-Za-z0-9]*`), so a param slot is always a valid GLSL/JS identifier fragment.
 */
export function assertValidParamName(name: unknown): asserts name is string {
  if (typeof name !== "string") {
    throw new Error("param.name must be a string");
  }
  assertValidAttributeName(name, "param.name");
}

/** The render uniform slot for a param name - stable across edits, so the timeline addresses it. */
export function paramUniformName(name: string): string {
  return `u_param_${name}`;
}

/** The behavior binding slot for a param name (scalar); a vector adds `_x`/`_y`/... per component. */
export function paramBindingName(name: string): string {
  return `b_param_${name}`;
}

/**
 * Coerces a raw param default value to exactly `width` finite components (missing pad with 0,
 * extras truncate), but rejects a non-finite/non-numeric component - no silent NaN in the uniform.
 */
export function coerceParamValue(width: number, raw: unknown): number | readonly number[] {
  const source = typeof raw === "number" ? [raw] : Array.isArray(raw) ? (raw as unknown[]) : [];
  const output = new Array<number>(width);
  let firstComponent = 0;
  for (let i = 0; i < width; i++) {
    const component = source[i] ?? 0;
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new Error(`param value component ${i.toString()} must be a finite number`);
    }
    output[i] = component;
    if (i === 0) {
      firstComponent = component;
    }
  }
  return width === 1 ? firstComponent : output;
}

/**
 * The shared, mutable state of a `timeline-value` node - identical across its render (uniform) and
 * behavior (binding) twins, so it lives here rather than hand-synced in both. `name`/`type` are
 * structural (fold into {@link cacheKey}); `currentValue` is the live default.
 */
export class FXTimelineValueState {
  public paramName: string;
  public valueType: FXValueType;
  public currentValue: number | readonly number[];

  constructor(name: string, type: FXValueType, value: number | readonly number[]) {
    assertValidParamName(name);
    this.paramName = name;
    this.valueType = type;
    this.currentValue = coerceParamValue(type.components, value);
  }

  /** Re-applies `name`/`type` in place (output stays generic `T`, no re-mint) and reshapes `value`. */
  public applyParams(parameters: Readonly<Record<string, unknown>>): void {
    const type = parameters["type"];
    if (type !== undefined) {
      this.valueType = resolveParamType(type);
    }
    const name = parameters["name"];
    if (name !== undefined) {
      assertValidParamName(name);
      this.paramName = name;
    }
    this.currentValue = coerceParamValue(
      this.valueType.components,
      parameters["value"] ?? this.currentValue,
    );
  }

  /** `name:typeId` - name + type decide the slot name and shape, so a change to either recompiles. */
  public cacheKey(): string {
    return `${this.paramName}:${this.valueType.id}`;
  }
}
