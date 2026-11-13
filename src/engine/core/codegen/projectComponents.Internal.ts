import type { FXExpr } from "../ir/FXExpr";
import { swizzle } from "../ir/FXExprBuilder";
import { FX_FUNCTIONS, isElementwiseFunction } from "../ir/FXFunctions.Internal";
import { childrenOf, withChildren } from "../ir/visit.Internal";
import type { FXValueType } from "../socket/FXValueType";
import { FX_VALUE_TYPES, isMatrixType, isNumericType } from "../socket/FXValueType";
import type { FXTypedLocal } from "./drawStage.Internal";

/**
 * Component projection of an SSA plan: what of the plan some components of its values need, with
 * every vector local cut down to the components of it actually read. A plan's program that reads
 * only an alpha (a shadow caster) then computes the alpha and nothing beside it - the color, the
 * lighting feeding only the color - while the plan it comes from stays as it was.
 */

/** Some components of a local of the plan, by index (`0` = `x`), in the order they are wanted. */
export interface FXComponentRoot {
  readonly name: string;
  readonly channels: readonly number[];
}

/** What {@link projectComponents} needs of the compiler: fresh names, and its own locals. */
export interface FXProjectionPolicy<L extends FXTypedLocal> {
  /** A name no local of the plan has. */
  nextName(): string;
  /** A local `expr` of `type` under `name`, made of `local` - keeping whatever else the compiler
   *  holds of it (the node that emitted it, the stage it runs in). */
  derive(local: L, name: string, type: FXValueType, expr: FXExpr): L;
}

/** A projected plan: its locals, and the local each root's value is in, root by root. */
export interface FXProjection<L extends FXTypedLocal> {
  /**
   * The locals the roots read, transitively, in definition order. One read whole and reading only
   * locals read whole is the plan's own, name and all; one read in part (a vector cut down to the
   * components read of it), or reading such a local, is a new local under a new name.
   */
  readonly locals: readonly L[];
  readonly roots: readonly string[];
}

/**
 * Projects `locals` (in definition order: a local reads only earlier ones) onto `roots`. A
 * component of a value is computed from the components of what it reads that make it: the same
 * component of an element-wise operation's vector operands (a scalar one whole), the argument of
 * a constructor it comes from, the source component of a swizzle. Whatever mixes components - a
 * matrix, a reduction, `raw` code, a packed or impure call - reads each of its operands whole.
 */
export function projectComponents<L extends FXTypedLocal>(
  locals: readonly L[],
  roots: readonly FXComponentRoot[],
  policy: FXProjectionPolicy<L>,
): FXProjection<L> {
  const defined = new Set(locals.map((local) => local.name));
  const demand = new Map<string, Set<number>>();
  const want = (name: string, channels: readonly number[]): void => {
    const wanted = demand.get(name) ?? new Set<number>();
    for (const channel of channels) {
      wanted.add(channel);
    }
    demand.set(name, wanted);
  };
  /** The components of `local` a projection reads: those wanted, or all when it cannot be cut -
   *  a matrix, an integer, or a local bound to a value of another type than its own. */
  const channelsOf = (local: L): number[] => {
    const wanted = demand.get(local.name) ?? new Set<number>();
    return isNumericType(local.type) && local.expr.type.id === local.type.id
      ? [...wanted].sort((a, b) => a - b)
      : allOf(local.type);
  };
  /** The components of `local`'s expression that make `channels` of it. */
  const exprChannels = (local: L, channels: number[]): number[] =>
    local.expr.type.id === local.type.id ? channels : allOf(local.expr.type);

  for (const root of roots) {
    want(root.name, root.channels);
  }
  // Last to first: every reader of a local is visited before it, so its demand is complete.
  const recording: FXLocalResolver = {
    renames: 0,
    read: (reference, channels) => {
      if (defined.has(reference.name)) {
        want(reference.name, channels);
      }
      return pickComponents(reference, channels);
    },
  };
  for (const local of [...locals].reverse()) {
    if (demand.has(local.name)) {
      project(local.expr, exprChannels(local, channelsOf(local)), recording);
    }
  }

  /** What each projected local became: its name, type and the original components it holds. */
  const variants = new Map<string, FXLocalVariant>();
  const rewriting: FXLocalResolver = {
    renames: 0,
    read(reference, channels) {
      const variant = variants.get(reference.name);
      if (variant === undefined || variant.name === reference.name) {
        return pickComponents(reference, channels);
      }
      this.renames++;
      return pickComponents(
        { kind: "ref", type: variant.type, ref: "local", name: variant.name },
        channels.map((channel) => variant.channels.indexOf(channel)),
      );
    },
  };
  const projected: L[] = [];
  for (const local of locals) {
    if (!demand.has(local.name)) {
      continue;
    }
    const channels = channelsOf(local);
    const expr = project(local.expr, exprChannels(local, channels), rewriting);
    const whole = channels.length === local.type.components;
    if (whole && expr === local.expr) {
      variants.set(local.name, { name: local.name, type: local.type, channels });
      projected.push(local);
      continue;
    }
    const type = whole ? local.type : numericType(channels.length);
    if (expr.kind === "ref" && expr.ref === "local" && expr.type.id === type.id) {
      // What is left is another local's value: read that one, with no alias between.
      variants.set(local.name, { name: expr.name, type, channels });
      continue;
    }
    const name = policy.nextName();
    variants.set(local.name, { name, type, channels });
    projected.push(policy.derive(local, name, type, expr));
  }

  const rootNames = roots.map((root) => {
    const local = locals.find((candidate) => candidate.name === root.name);
    if (local === undefined) {
      throw new Error(`projectComponents: no local "${root.name}"`);
    }
    const reference = { kind: "ref", type: local.type, ref: "local", name: root.name } as const;
    const value = rewriting.read(reference, root.channels);
    if (value.kind === "ref") {
      return value.name;
    }
    // A reorder or a part of a local the projection keeps wider for another reader.
    const name = policy.nextName();
    projected.push(policy.derive(local, name, value.type, value));
    return name;
  });
  return { locals: projected, roots: rootNames };
}

interface FXLocalVariant {
  readonly name: string;
  readonly type: FXValueType;
  /** The original local's components this one holds, in its own component order. */
  readonly channels: readonly number[];
}

/** How a projection reads a local: `read` gives the value of its components `channels`;
 *  `renames` counts the reads answered by another local than the one read. */
interface FXLocalResolver {
  renames: number;
  read(reference: Extract<FXExpr, { kind: "ref" }>, channels: readonly number[]): FXExpr;
}

const SWIZZLE_CHANNELS = "xyzw";

/** The component indices a swizzle's `channels` (`"xyzw"` letters) name. */
export function componentIndices(channels: string): number[] {
  return [...channels].map((channel) => SWIZZLE_CHANNELS.indexOf(channel));
}

function allOf(type: FXValueType): number[] {
  return Array.from({ length: type.components }, (_, index) => index);
}

function isWhole(type: FXValueType, channels: readonly number[]): boolean {
  return channels.length === type.components && channels.every((channel, i) => channel === i);
}

function numericType(components: number): FXValueType {
  switch (components) {
    case 1:
      return FX_VALUE_TYPES.float;
    case 2:
      return FX_VALUE_TYPES.vec2;
    case 3:
      return FX_VALUE_TYPES.vec3;
    case 4:
      return FX_VALUE_TYPES.vec4;
    default:
      throw new Error(`projectComponents: no numeric type of ${String(components)} components`);
  }
}

/** Components `channels` of `expr` itself: `expr` when that is all of it, else its swizzle. */
export function pickComponents(expr: FXExpr, channels: readonly number[]): FXExpr {
  if (isWhole(expr.type, channels)) {
    return expr;
  }
  return swizzle(expr, channels.map((channel) => SWIZZLE_CHANNELS.charAt(channel)).join(""));
}

/**
 * `expr`'s components `channels`, in that order, computed from only what makes them. Read whole
 * and reading no local under another name, it is `expr` itself (the same object). Each local read
 * goes through `resolve`.
 */
function project(expr: FXExpr, channels: readonly number[], resolve: FXLocalResolver): FXExpr {
  const renames = resolve.renames;
  const projected = projectParts(expr, channels, resolve);
  return isWhole(expr.type, channels) && resolve.renames === renames ? expr : projected;
}

function projectParts(expr: FXExpr, channels: readonly number[], resolve: FXLocalResolver): FXExpr {
  if (!isNumericType(expr.type)) {
    // A matrix or an integer: read whole, as only a reader mixing components reads one.
    if (!isWhole(expr.type, channels)) {
      throw new Error(`projectComponents: a part of a ${expr.type.id} value`);
    }
    return expr.kind === "ref" && expr.ref === "local"
      ? resolve.read(expr, channels)
      : whole(expr, resolve);
  }
  const width = numericType(channels.length);
  switch (expr.kind) {
    case "lit":
      return {
        kind: "lit",
        type: width,
        values: channels.map((channel) => expr.values[channel] ?? 0),
      };
    case "ref":
      return expr.ref === "local" ? resolve.read(expr, channels) : pickComponents(expr, channels);
    case "swizzle": {
      const sources = componentIndices(expr.channels);
      const wanted = channels.map((channel) => sources[channel] ?? 0);
      const read = [...new Set(wanted)].sort((a, b) => a - b);
      return pickComponents(
        project(expr.a, read, resolve),
        wanted.map((source) => read.indexOf(source)),
      );
    }
    case "bin":
      if (isMatrixType(expr.a.type) || isMatrixType(expr.b.type)) {
        return pickComponents(whole(expr, resolve), channels);
      }
      return {
        ...expr,
        type: width,
        a: elementwiseOperand(expr.a, channels, resolve),
        b: elementwiseOperand(expr.b, channels, resolve),
      };
    case "un":
      return { ...expr, type: width, a: elementwiseOperand(expr.a, channels, resolve) };
    case "call":
      if (!isElementwiseCall(expr, channels.length)) {
        return pickComponents(whole(expr, resolve), channels);
      }
      return {
        ...expr,
        type: width,
        args: expr.args.map((arg) => elementwiseOperand(arg, channels, resolve)),
      };
    case "select":
      return {
        ...expr,
        type: width,
        cond: project(expr.cond, allOf(expr.cond.type), resolve),
        a: project(expr.a, channels, resolve),
        b: project(expr.b, channels, resolve),
      };
    case "construct":
      return projectConstruct(expr, channels, resolve);
    case "column":
    case "raw":
      return pickComponents(whole(expr, resolve), channels);
  }
}

/** `expr` read whole: each child read whole, `expr` itself when none changes. */
function whole(expr: FXExpr, resolve: FXLocalResolver): FXExpr {
  const children = childrenOf(expr);
  const projected = children.map((child) => project(child, allOf(child.type), resolve));
  return projected.every((child, index) => child === children[index])
    ? expr
    : withChildren(expr, projected);
}

/** An element-wise operand's part in components `channels` of the result: a scalar whole. */
function elementwiseOperand(
  operand: FXExpr,
  channels: readonly number[],
  resolve: FXLocalResolver,
): FXExpr {
  return operand.type.components === 1
    ? project(operand, [0], resolve)
    : project(operand, channels, resolve);
}

/** Whether `expr` is an element-wise call that has an overload `width` components wide. */
function isElementwiseCall(expr: Extract<FXExpr, { kind: "call" }>, width: number): boolean {
  const components = expr.type.components;
  if (
    !isElementwiseFunction(expr.fn) ||
    !expr.args.every(
      (arg) =>
        isNumericType(arg.type) &&
        (arg.type.components === 1 || arg.type.components === components),
    )
  ) {
    return false;
  }
  const result = numericType(width).glslTypeName;
  const args = expr.args.map((arg) => (arg.type.components === 1 ? arg.type.glslTypeName : result));
  return (
    FX_FUNCTIONS.get(expr.fn)?.signatures.some(
      (signature) =>
        signature.result === result &&
        signature.args.length === args.length &&
        signature.args.every((type, index) => type === args[index]),
    ) ?? false
  );
}

/** Components `channels` of a vector constructor: the arguments they come from, each projected
 *  onto its part, constructed back when they come from more than one. */
function projectConstruct(
  expr: Extract<FXExpr, { kind: "construct" }>,
  channels: readonly number[],
  resolve: FXLocalResolver,
): FXExpr {
  if (isMatrixType(expr.type)) {
    return whole(expr, resolve);
  }
  // Each component of the result, as (argument, its component).
  const origins: { readonly arg: number; readonly component: number }[] = [];
  expr.args.forEach((arg, index) => {
    for (let component = 0; component < arg.type.components; component++) {
      origins.push({ arg: index, component });
    }
  });
  // Consecutive wanted components of one argument make one piece.
  const pieces: { readonly arg: number; readonly components: number[] }[] = [];
  for (const channel of channels) {
    const origin = origins[channel];
    if (origin === undefined) {
      throw new Error(`projectComponents: component ${String(channel)} of a ${expr.type.id}`);
    }
    const last = pieces.at(-1);
    if (last?.arg === origin.arg) {
      last.components.push(origin.component);
    } else {
      pieces.push({ arg: origin.arg, components: [origin.component] });
    }
  }
  const args = pieces.map((piece) => {
    const arg = expr.args[piece.arg];
    if (arg === undefined) {
      throw new Error("projectComponents: constructor argument out of range");
    }
    return { arg, components: piece.components };
  });
  // An integer argument cannot be cut (it converts as a whole): the constructor is read whole.
  if (
    args.some(({ arg, components }) => !isNumericType(arg.type) && !isWhole(arg.type, components))
  ) {
    return pickComponents(whole(expr, resolve), channels);
  }
  const projected = args.map(({ arg, components }) => project(arg, components, resolve));
  const [only] = projected;
  return projected.length === 1 && only !== undefined
    ? only
    : { kind: "construct", type: numericType(channels.length), args: projected };
}
