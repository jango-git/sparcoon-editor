import { describe, expect, it } from "vitest";
import { FX_STANDARD_NODES } from "../../src/engine/nodes-std/index";
import { FX_MANUAL_NODE_METAS } from "../../src/engine/nodes-std/manualNodeMetas";
import nodesEn from "../../src/i18n/locales/nodes.en.json" with { type: "json" };

/**
 * Node definitions carry no display text (see `src/i18n/nodeText.ts` for why) - this is the
 * completeness guarantee that used to be `label: string` (required) on `FXNodeDescriptor` and
 * the `contract.test.ts` non-empty-description check: every registered node `type` must have a
 * `label` and a resolvable `description` in the English dictionary, so the editor never shows a
 * blank title or silently omits the help tooltip. Reads `nodes.en.json` directly (a static
 * import), not through the runtime `i18n/nodeText.ts` loader, which fetches at runtime and so
 * needs a real HTTP origin - unavailable under vitest's Node environment.
 */

type NodeTextEntry = (typeof nodesEn)[keyof typeof nodesEn];

function descriptionFor(entry: NodeTextEntry | undefined, domain: string): string | undefined {
  const value = entry?.description;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return (value as Record<string, string>)[domain];
}

const RESERVED_TYPES: readonly { readonly type: string; readonly domain: string }[] = [
  { type: "$spawn", domain: "behavior" },
  { type: "$update", domain: "behavior" },
  { type: "$out", domain: "render" },
];
/** The route node has no help tooltip (no description) - see `domain/fakeNodes.ts`'s `routeMeta`. */
const ROUTE_TYPE = "$route";

describe("node-text dictionary completeness (nodes.en.json)", () => {
  const cases = [
    ...FX_STANDARD_NODES.map((definition) => ({
      type: definition.type,
      domain: definition.domain,
    })),
    ...FX_MANUAL_NODE_METAS.map((meta) => ({ type: meta.type, domain: meta.domain })),
    ...RESERVED_TYPES,
  ];

  for (const { type, domain } of cases) {
    it(`${type} (${domain}) has a non-empty label and description`, () => {
      const entry = (nodesEn as Record<string, NodeTextEntry>)[type];
      expect(entry, `no nodes.en.json entry for "${type}"`).toBeDefined();
      expect(entry.label.length).toBeGreaterThan(0);
      const description = descriptionFor(entry, domain);
      expect(description, `no description for "${type}" in domain "${domain}"`).toBeDefined();
      expect((description ?? "").length).toBeGreaterThan(0);
    });
  }

  it(`${ROUTE_TYPE} has a non-empty label (no description - it has no help tooltip)`, () => {
    const entry = (nodesEn as Record<string, NodeTextEntry>)[ROUTE_TYPE];
    expect(entry).toBeDefined();
    expect(entry.label.length).toBeGreaterThan(0);
  });

  it("has no orphaned entries for a type nothing registers", () => {
    const known = new Set([
      ...FX_STANDARD_NODES.map((definition) => definition.type),
      ...FX_MANUAL_NODE_METAS.map((meta) => meta.type),
      ...RESERVED_TYPES.map((entry) => entry.type),
      ROUTE_TYPE,
    ]);
    const orphaned = Object.keys(nodesEn).filter((type) => !known.has(type));
    expect(orphaned).toEqual([]);
  });
});

describe("node-text search tags (nodes.en.json)", () => {
  it("every searchTags entry is a non-empty array of non-empty, deduped strings", () => {
    for (const [type, entry] of Object.entries(nodesEn as Record<string, NodeTextEntry>)) {
      const tags = entry.searchTags;
      if (tags === undefined) {
        continue;
      }
      expect(tags.length, `${type}: empty searchTags array`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag.length, `${type}: empty search tag`).toBeGreaterThan(0);
      }
      expect(new Set(tags).size, `${type}: duplicate search tag`).toBe(tags.length);
    }
  });
});
