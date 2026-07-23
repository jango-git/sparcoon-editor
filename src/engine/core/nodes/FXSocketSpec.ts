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
  /** Omit for a static, node-authored socket (its text lives in `i18n/nodeText.ts` by `type` +
   *  this record's key instead) - set only for instance-specific text with no stable translation
   *  key, e.g. a user's own attribute name (`sinkMeta.ts`'s `attributeSocket`). */
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
  /** Editor hint for the inline {@link value} control (per-component for vectors). */
  readonly min?: number;
  /** Editor hint for the inline {@link value} control (per-component for vectors). */
  readonly max?: number;
  /** Editor hint for the inline {@link value} control (per-component for vectors). */
  readonly step?: number;
  /** This vec3/vec4 inline default is a color - render a picker swatch instead of raw fields. */
  readonly color?: boolean;
}

/** Input fallback that reads a host-provided builtin from the compile target. */
export interface FXTargetInputDefault {
  readonly targetInput: string;
}

/** Palette grouping for a node - fixed (not free-form) so every node lands in exactly one group. */
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
 * JSON-serializable metadata describing a node definition: everything an external editor
 * needs for a palette and inspector, with no runtime instance and no `three` types. Carries no
 * display text (label/description) - the editor resolves those by `type` via `i18n/nodeText.ts`
 * at render time, since this can be built before a locale finishes loading.
 * Produced by {@link FXNodeDefinition.describe}.
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
   * name, an opaque texture, a gradient) - present only on the hand-written manual nodes.
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
   * `attribute-name` - a picker of declared attributes; `texture`/`gradient` - a resource
   * picker / gradient editor; `param-name` - a free-text field naming a param's stable
   * uniform/binding slot.
   */
  readonly kind: "attribute-name" | "texture" | "gradient" | "param-name";
  readonly required: boolean;
}

/**
 * JSON-serializable form of one parameter's schema entry - the editor-facing view of a param.
 * It is exactly {@link FXParamSpec}: `describe()` surfaces a node's param specifications verbatim (no
 * transform), so the two are one type rather than two hand-synced unions.
 */
export type FXParamMeta = FXParamSpec;
