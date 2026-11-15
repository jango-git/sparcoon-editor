/**
 * The checks an emitter's strips (its trail and ribbon graphs) and their particles are held to
 * beyond their own compile - shared by the live preview and the export, so the two never accept
 * different strips - and the geometry a strip artifact names (the runtime builds a strip's own
 * segment quad and ignores it).
 */

import type { FXGeometrySource } from "sparcoon";

import { mergeAttributeCollections } from "../engine/core/compiler/collectAttributeRequests";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { FXAttributeRequest } from "../engine/core/socket/FXAttribute";
import type { EmitterDoc } from "../model/editorState";
import type { EditorAttribute } from "./graphModel";
import { undeclaredAttributeErrors } from "./serialize";
import {
  readRenderSinkConfig,
  readRibbonSinkConfig,
  RENDER_SINK_ID,
  STRIP_HOSTS,
  type StripHost,
} from "./sinkMeta";

/** The geometry every strip artifact carries. */
export const STRIP_GEOMETRY: FXGeometrySource = { type: "primitive", primitive: "plane" };

/**
 * A trail or ribbon (`strip`) on a depth-sorted emitter: a sort moves particles between slots, and
 * a strip follows them slot by slot. Attributed to the render graph's surface sink, where Sort
 * Every lives.
 */
export function stripSortError(
  strip: StripHost,
  sortInterval: number,
): FXCompilerError | undefined {
  return sortInterval > 0
    ? {
        code: strip === "trail" ? "trail-with-sort" : "ribbon-with-sort",
        message: `a ${strip} cannot be combined with depth sorting - set the render graph's Sort Every to 0`,
        nodeId: RENDER_SINK_ID,
      }
    : undefined;
}

/** A depth-sorted emitter that does not draw its particles: there is nothing to sort. Attributed
 *  to the render graph's surface sink, where both settings live. */
export function hiddenParticlesSortError(config: {
  readonly sortInterval: number;
  readonly drawParticles: boolean;
}): FXCompilerError | undefined {
  return config.sortInterval > 0 && !config.drawParticles
    ? {
        code: "sort-without-particles",
        message:
          "an emitter that does not draw its particles cannot sort - set Sort Every to 0 or turn Draw Particles on",
        nodeId: RENDER_SINK_ID,
      }
    : undefined;
}

/** A warning on an emitter that draws neither its particles nor a trail or ribbon. */
export function emitterDrawsNothingWarnings(emitter: EmitterDoc): readonly FXCompilerError[] {
  const drawsParticles = readRenderSinkConfig(emitter.renderGraph).drawParticles;
  return drawsParticles || STRIP_HOSTS.some((host) => emitter[`${host}Graph`] !== undefined)
    ? []
    : [
        {
          code: "emitter-draws-nothing",
          message:
            "this emitter draws neither its particles nor a trail or ribbon - turn Draw Particles on or add a trail or ribbon",
          nodeId: RENDER_SINK_ID,
        },
      ];
}

/**
 * The warnings on `emitter`'s strip of `strip` that its spawns make, for a ribbon (a trail follows
 * each particle on its own, so none):
 * - births that do not follow one another - a burst of several particles, or a reaction (each
 *   source particle spawns its own) - since a ribbon joins each particle to the one born right
 *   after it, wherever that one was born;
 * - a Head with no play to show it: the head shows only while a play emits from the emitter.
 */
export function stripSpawnWarnings(
  strip: StripHost,
  emitter: EmitterDoc,
): readonly FXCompilerError[] {
  if (strip !== "ribbon" || emitter.ribbonGraph === undefined) {
    return [];
  }
  const warnings: FXCompilerError[] = [];
  if (
    emitter.reactions.length > 0 ||
    emitter.events.some((event) => event.kind === "burst" && event.count > 1)
  ) {
    warnings.push({
      code: "ribbon-interleaved-births",
      message:
        "bursts of several particles or reactions weave this emitter's ribbon between births from different places",
    });
  }
  if (
    readRibbonSinkConfig(emitter.ribbonGraph).head &&
    !emitter.events.some((event) => event.kind === "play")
  ) {
    warnings.push({
      code: "ribbon-head-without-play",
      message:
        "this ribbon's Head never shows, since it shows only while a play emits from the emitter",
      nodeId: RENDER_SINK_ID,
    });
  }
  return warnings;
}

/**
 * A strip's attribute reads against the behavior graph: a read at another width than the behavior
 * writes it, or of an attribute the emitter does not declare.
 */
export function stripAttributeErrors(
  trailAttributes: readonly FXAttributeRequest[],
  behaviorAttributes: readonly FXAttributeRequest[],
  declared: readonly EditorAttribute[],
): readonly FXCompilerError[] {
  return [
    ...mergeAttributeCollections(
      { requests: trailAttributes, errors: [] },
      { requests: behaviorAttributes, errors: [] },
    ).errors,
    ...undeclaredAttributeErrors(trailAttributes, [], declared),
  ];
}
