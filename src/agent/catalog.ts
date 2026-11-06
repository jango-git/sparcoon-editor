/**
 * The node catalog as the add-node menu sees it: which node types a graph offers, and each
 * type's sockets and parameters. Metadata comes straight from the engine palette; labels and
 * descriptions come from the active locale's node text.
 */

import {
  isMeshExcludedRenderNode,
  metaFor,
  paletteForKind,
  type FXNodeMeta,
} from "../domain/nodePalette";
import { nodeDescription, nodeLabel } from "../i18n/nodeText";
import { graphKindFor, parseGraphName } from "./address.Internal";
import { requireKnownKeys } from "./arguments.Internal";
import { AgentError } from "./errors";

export interface NodeTypeSummary {
  readonly type: string;
  readonly category: FXNodeMeta["category"];
  readonly label: string;
  readonly description: string | undefined;
}

/**
 * A node type's full engine metadata plus its display text. A node's stored parameters are its
 * `params`, its `customParams` (texture, gradient, attribute/param names) and the inline values
 * of the `inputs` that carry a `control` - an editable input uses its inline value until a wire
 * feeds it. All three are set through `graph(...).setParams`.
 */
export type NodeTypeInfo = FXNodeMeta & {
  readonly label: string;
  readonly description: string | undefined;
};

export interface CatalogApi {
  /** Node types `graph` offers; `{ mesh: true }` drops those a VFX mesh can't host. */
  nodeTypes(graph: string, options?: { readonly mesh?: boolean }): readonly NodeTypeSummary[];
  /** Sockets, parameters, generic constraint and phase/stage of one node type. */
  nodeType(graph: string, type: string): NodeTypeInfo;
}

function summarize(metadata: FXNodeMeta): NodeTypeSummary {
  return {
    type: metadata.type,
    category: metadata.category,
    label: nodeLabel(metadata.type) ?? metadata.type,
    description: nodeDescription(metadata.type, { domain: metadata.domain }),
  };
}

/**
 * Engine metadata (a palette type's, or a placed node's as shaped now) with its display text, as
 * a private copy - the palette's own objects are shared by the whole editor.
 */
export function describeNodeType(metadata: FXNodeMeta): NodeTypeInfo {
  return { ...structuredClone(metadata), ...summarize(metadata) };
}

export function createCatalogApi(): CatalogApi {
  return {
    nodeTypes: (graph, options = {}): readonly NodeTypeSummary[] => {
      requireKnownKeys("options", options, ["mesh"]);
      const kind = graphKindFor(parseGraphName(graph));
      return paletteForKind(kind)
        .filter((metadata) => options.mesh !== true || !isMeshExcludedRenderNode(metadata))
        .map(summarize);
    },
    nodeType: (graph, type): NodeTypeInfo => {
      const metadata = metaFor(graphKindFor(parseGraphName(graph)), type);
      if (metadata === undefined) {
        throw new AgentError("not_found", `No node type "${type}" in the ${graph} graph.`);
      }
      return describeNodeType(metadata);
    },
  };
}
