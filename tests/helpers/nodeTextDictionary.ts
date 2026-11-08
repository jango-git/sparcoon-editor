import nodesEn from "../../src/i18n/locales/nodes.en.json" with { type: "json" };

export interface NodeTextLabelEntry {
  readonly label?: string;
}

/**
 * One node's dictionary entry, mirroring the (module-private) shape in `src/i18n/nodeText.ts`.
 * Typed by hand rather than as `(typeof nodesEn)[keyof typeof nodesEn]`: that union of the
 * JSON's per-entry literal types only exposes keys every entry has, so optional fields such as
 * `inputs`/`searchTags` would not be readable.
 */
export interface NodeTextEntry {
  readonly label?: string;
  /** A plain string, or a `{ render, behavior }`-shaped per-domain variant map. */
  readonly description?: string | Readonly<Record<string, string>>;
  readonly inputs?: Readonly<Record<string, NodeTextLabelEntry>>;
  readonly outputs?: Readonly<Record<string, NodeTextLabelEntry>>;
  readonly params?: Readonly<Record<string, NodeTextLabelEntry>>;
  readonly searchTags?: readonly string[];
}

/** The whole English dictionary, keyed by node `type`. */
export const NODE_TEXT_EN: Readonly<Record<string, NodeTextEntry | undefined>> = nodesEn;

/**
 * Reads `nodes.en.json` directly (a static import, not the runtime `i18n/nodeText.ts` loader,
 * which fetches at runtime and so needs a real HTTP origin - unavailable under vitest's Node
 * environment). Tests that only need to assert dictionary *content* use this instead of
 * `initI18n()`.
 */
export function nodeTextEntry(type: string): NodeTextEntry | undefined {
  return NODE_TEXT_EN[type];
}
