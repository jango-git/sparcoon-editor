import nodesEn from "../../src/i18n/locales/nodes.en.json" with { type: "json" };

/**
 * Reads `nodes.en.json` directly (a static import, not the runtime `i18n/nodeText.ts` loader,
 * which fetches at runtime and so needs a real HTTP origin - unavailable under vitest's Node
 * environment). Tests that only need to assert dictionary *content* use this instead of
 * `initI18n()`.
 */
type NodeTextEntry = (typeof nodesEn)[keyof typeof nodesEn];

export function nodeTextEntry(type: string): NodeTextEntry | undefined {
  return (nodesEn as Record<string, NodeTextEntry | undefined>)[type];
}
