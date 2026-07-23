/**
 * Node-graph text (label/description/socket+param labels), resolved by a node's stable `type`
 * (plus a socket/param key) at render time - never baked into `FXNodeMeta`. `NODE_PALETTE`
 * (domain/nodePalette.ts) builds eagerly at module-load time, before `initI18n` resolves, so
 * baking translated text into it would race the locale fetch; resolving here, at the point the
 * UI actually paints a label, sidesteps that entirely (painting only starts after
 * `mountApplicationShell`, itself after `await initI18n()`).
 *
 * Keys are runtime strings (a node `type`), not compile-time literals, so there is no `TKey`-style
 * type check here - `tests/i18n/nodeText.test.ts` covers completeness instead. Every resolver
 * returns `undefined` on a miss (in both the active and English fallback dictionaries); the caller
 * decides the final fallback (usually `humanizeKey` or the raw `type`/key).
 */

interface NodeTextVariant {
  readonly [context: string]: string;
}

interface NodeTextSocketEntry {
  readonly label?: string;
}

interface NodeTextParamEntry {
  readonly label?: string;
}

interface NodeTextEntry {
  readonly label?: string;
  /** A plain string, or (only for a node whose text genuinely differs by domain, e.g.
   *  `read-attribute`/`timeline-value`) a `{ render: "...", behavior: "..." }`-shaped variant map. */
  readonly description?: string | NodeTextVariant;
  readonly inputs?: Readonly<Record<string, NodeTextSocketEntry>>;
  readonly outputs?: Readonly<Record<string, NodeTextSocketEntry>>;
  readonly params?: Readonly<Record<string, NodeTextParamEntry>>;
  /** Curated invisible search aliases ("swirl" surfaces Vortex) - never displayed, only matched. */
  readonly searchTags?: readonly string[];
}

type NodeTextDictionary = Readonly<Record<string, NodeTextEntry>>;

const DEFAULT_LOCALE = "en";

let activeDictionary: NodeTextDictionary = {};
let fallbackDictionary: NodeTextDictionary = {};

async function loadNodeDictionary(code: string): Promise<NodeTextDictionary> {
  const url = new URL(`locales/nodes.${code}.json`, import.meta.url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load node text "${code}": ${response.status}`);
  }
  return (await response.json()) as NodeTextDictionary;
}

/** Must be awaited before any resolver call - see {@link initI18n}, which calls this. */
export async function initNodeText(locale: string): Promise<void> {
  const [fallback, current] = await Promise.all([
    loadNodeDictionary(DEFAULT_LOCALE),
    locale === DEFAULT_LOCALE
      ? Promise.resolve(undefined)
      : loadNodeDictionary(locale).catch((error: unknown) => {
          console.warn(error);
          return undefined;
        }),
  ]);
  fallbackDictionary = fallback;
  activeDictionary = current ?? fallback;
}

export function nodeLabel(type: string): string | undefined {
  return activeDictionary[type]?.label ?? fallbackDictionary[type]?.label;
}

function resolveDescription(
  entry: NodeTextEntry | undefined,
  context: { readonly domain?: string | undefined } | undefined,
): string | undefined {
  const value = entry?.description;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return context?.domain === undefined ? undefined : value[context.domain];
}

export function nodeDescription(
  type: string,
  context?: { readonly domain?: string | undefined },
): string | undefined {
  return (
    resolveDescription(activeDictionary[type], context) ??
    resolveDescription(fallbackDictionary[type], context)
  );
}

export function nodeSocketLabel(
  type: string,
  side: "inputs" | "outputs",
  key: string,
): string | undefined {
  return (
    activeDictionary[type]?.[side]?.[key]?.label ?? fallbackDictionary[type]?.[side]?.[key]?.label
  );
}

export function nodeParamLabel(type: string, key: string): string | undefined {
  return (
    activeDictionary[type]?.params?.[key]?.label ?? fallbackDictionary[type]?.params?.[key]?.label
  );
}

/**
 * Curated search aliases for `type`, merged from the active locale AND the English fallback (not
 * "active, else fallback" like the other resolvers above) - these tags are never displayed, only
 * matched, so there is no mixed-language-display risk, and merging means a user who types an
 * English technical term still finds the node even when the active locale has its own aliases too.
 */
export function nodeSearchTags(type: string): readonly string[] {
  const tags = new Set<string>(activeDictionary[type]?.searchTags ?? []);
  for (const tag of fallbackDictionary[type]?.searchTags ?? []) {
    tags.add(tag);
  }
  return [...tags];
}
