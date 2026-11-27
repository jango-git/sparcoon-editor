import type { FXExpr } from "../ir/FXExpr";
import type { FXGLSLTypeName } from "../socket/FXValueType";
import type { FXParamSpec } from "./FXParamSpec";

/**
 * Declarative description of a single node port for {@link defineNode}. The record key
 * naming the specification becomes the socket's stable `key`.
 */
export interface FXSocketSpec {
  /** A concrete GLSL type, or `"T"` (the descriptor must then declare its `generic` constraint). */
  readonly type: FXGLSLTypeName | "T";
  /** Set only for instance-specific text with no stable translation key (a user's attribute
   *  name). Omit otherwise: static text is resolved by `type` and socket key. */
  readonly label?: string;
  readonly description?: string;
  /** Inputs only: fails validation if unconnected with no {@link default}. */
  readonly required?: boolean;
  /**
   * Inputs only: static fallback when unconnected - a literal IR expression, or a
   * target-provided builtin read (`{ targetInput: "PARTICLE_VELOCITY" }`). For an
   * inline-editable default (the "value on the pin"), use {@link value} instead.
   */
  readonly default?: FXExpr | FXTargetInputDefault;
  /**
   * Inputs only: an editable inline literal default (UE-style "value on the pin"). Baked
   * as an IR literal (no uniform/binding allocated), so it participates in the structural
   * hash and editing it recompiles. Mutually exclusive with {@link default}; with no sibling
   * `valueType` param (e.g. `binary-op`'s `a`/`b`), width instead follows whatever `T`
   * resolves to at compile time, padded/truncated at build.
   */
  readonly value?: number | readonly number[];
  /** Editor hint: lower bound of the inline {@link value} control. */
  readonly min?: number;
  /** Editor hint: upper bound of the inline {@link value} control. */
  readonly max?: number;
  /** Editor hint: step of the inline {@link value} control. */
  readonly step?: number;
  /** This vec3/vec4 inline default is a color - render a picker swatch instead of raw fields. */
  readonly color?: boolean;
}

/** Input fallback that reads a host-provided builtin from the compile target. */
export interface FXTargetInputDefault {
  readonly targetInput: string;
}

/** Palette group of a node. */
export type FXNodeCategory =
  | "source"
  | "math"
  | "matrix"
  | "color"
  | "uv"
  | "mask"
  | "normal"
  | "lighting"
  | "force"
  | "spawn"
  | "over-life"
  | "attribute";

/** JSON-serializable description of one socket, surfaced through {@link FXNodeMeta}. */
export interface FXSocketMeta {
  readonly key: string;
  /** Concrete GLSL type, or `"T"` for the node's generic type variable. */
  readonly type: FXGLSLTypeName | "T";
  readonly label?: string;
  /** One-line tooltip describing what this port carries. */
  readonly description?: string;
  readonly required?: boolean;
  /**
   * Inputs only: the unconnected fallback for the inspector's "unconnected => ..." display.
   * A literal surfaces as its number/number-array value, a target-input default as
   * `{ targetInput }`; absent (no key) means either no default at all or a non-literal IR expr
   * with nothing serializable to show - {@link socketDefaultExpr}'s presence check is what
   * distinguishes "has a default" from "unconnected is an error", not this field's shape.
   */
  readonly default?: number | readonly number[] | { readonly targetInput: string };
  /**
   * Inputs only: present when the socket carries an editable inline default (the
   * descriptor's {@link FXSocketSpec.value}) - the editor renders a value control while
   * unconnected. Absent on a non-editable socket, which shows only its dot.
   */
  readonly control?: {
    readonly default: number | readonly number[];
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
    /** When true, the value is a linear-RGB(A) color: render a picker swatch, not fields. */
    readonly color?: boolean;
  };
}

/**
 * JSON-serializable metadata of a node definition, produced by {@link FXNodeDefinition.describe}.
 * Carries no display text: the editor resolves label and description by `type` at render time,
 * since this can be built before a locale loads.
 */
export interface FXNodeMeta {
  readonly type: string;
  /** Palette group (see {@link FXNodeCategory}). */
  readonly category: FXNodeCategory;
  readonly domain: "render" | "behavior" | "shared";
  /** Fixed stage, or `"param"` when picked from the synthesized `stage` param. Absent on behavior-only nodes. */
  readonly stage?: "vertex" | "fragment" | "param";
  /** Fixed phase, or `"param"` when picked from the synthesized `phase` param. Absent on render-only nodes. */
  readonly phase?: "spawn" | "update" | "param";
  readonly inputs: readonly FXSocketMeta[];
  readonly outputs: readonly FXSocketMeta[];
  readonly params: Readonly<Record<string, FXParamMeta>>;
  /**
   * Host builtins this node may read, for palette filtering: shown for a target only if
   * every name here is one of the target's inputs. `"dynamic"` means the set could not be
   * computed statically - validation rejects an illegal read on apply instead.
   */
  readonly reads: readonly string[] | "dynamic";
  /** Present when type-polymorphic: the constraint its `"T"` sockets can unify to. */
  readonly generic?: { readonly constraint: readonly FXGLSLTypeName[] };
  /**
   * Params that carry data {@link FXParamMeta} cannot express (a free-string attribute
   * name, an opaque texture, a gradient, an asset of the content library).
   */
  readonly customParams?: readonly FXCustomParamMeta[];
  /**
   * Complexity estimate (see {@link FXGraphNode.estimateCost}) at default param values and
   * (for a generic node) a `float` resolved type - a baseline only; the true per-instance
   * cost can differ once params move or `T` resolves wider.
   */
  readonly cost?: number;
}

/**
 * One param outside the {@link FXParamMeta} vocabulary, surfaced through
 * {@link FXNodeMeta.customParams}. `kind` tells the editor which widget to render.
 */
export interface FXCustomParamMeta {
  readonly key: string;
  /**
   * `attribute-name` - a picker of declared attributes; `inherit-source` - a picker of what a
   * dying particle hands its newborns (its emitter's attributes, and core fields);
   * `texture`/`gradient` - a resource picker / gradient editor; `param-name` - a free-text field
   * naming a param's stable uniform/binding slot. `mesh-asset`, `scene-mesh-asset`,
   * `skinned-mesh-asset` and `volume-asset` - a picker of the content library's assets of a kind
   * (see `FX_ASSET_KINDS`).
   */
  readonly kind:
    | "attribute-name"
    | "inherit-source"
    | "texture"
    | "gradient"
    | "param-name"
    | "mesh-asset"
    | "scene-mesh-asset"
    | "skinned-mesh-asset"
    | "volume-asset";
  readonly required: boolean;
}

/** Editor-facing view of a param schema entry. Identical to {@link FXParamSpec}. */
export type FXParamMeta = FXParamSpec;
