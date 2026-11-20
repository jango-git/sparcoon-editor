/**
 * Links a reaction to its source's compiled slot. The reacting emitter's spawn graph asks for
 * values by name (`inherited-attribute`, see `FXInherit.ts`), and the source's slot says where each
 * lies in a particle that is born or dies. Values are matched by name and exact type. A value the
 * source cannot supply keeps the reacting emitter's default and is reported.
 */

import { FX_CORE_LIFECYCLE, type FXParticleEventKind } from "sparcoon";
import { type FXSlotLayout, slotLayout } from "sparcoon/editor";

import type { FXCompiledKernel } from "../engine/behavior/FXCompiledKernel";
import {
  FX_INHERIT_BUILTIN_COMPONENT,
  inheritSourceLabel,
  inheritSourceOf,
} from "../engine/behavior/FXInherit";
import type { FXInheritEntry } from "../engine/behavior/FXInheritPlan";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { EmitterDoc } from "../model/editorState";
import { kernelWrittenBuffers } from "./attributeChecks";
import type { AttributeTypeName } from "./graphModel";

/** What a source emitter's particles hand out at birth and at death: their slot, and which of its
 *  fields are written by then - by the spawn alone at birth, by the spawn or an update at death. */
export interface ReactionSource {
  readonly slot: FXSlotLayout;
  readonly written: Readonly<Record<FXParticleEventKind, ReadonlySet<string>>>;
}

/** A source as its compiled behavior lays its particles out (as the runtime's `particleSlot`). */
export function reactionSourceOf(kernel: FXCompiledKernel): ReactionSource {
  return {
    slot: slotLayout(
      kernel.update.buffers.map((buffer) => ({ name: buffer.name, components: buffer.stride })),
    ),
    written: {
      birth: new Set(kernel.spawn?.writtenBuffers ?? []),
      death: kernelWrittenBuffers(kernel),
    },
  };
}

/** Why an inherited value keeps its default: the source has no such attribute, has it at another
 *  type, never writes it, or writes it only in its update while the reaction fires at birth. */
export interface InheritIssue {
  readonly kind: "missing" | "mistyped" | "unwritten" | "late";
  readonly name: string;
  /** The type the reacting emitter reads it as. */
  readonly expected: string;
  /** The type the source holds it as (`mistyped` only). */
  readonly found?: string;
}

/** A reaction's copies (the runtime's `FXInheritCopies`) and what they leave at defaults. */
export interface ReactionLink {
  readonly copies: readonly number[];
  readonly issues: readonly InheritIssue[];
}

const TYPE_OF_COMPONENTS: readonly AttributeTypeName[] = ["float", "vec2", "vec3", "vec4"];

function typeOfComponents(components: number): string {
  return TYPE_OF_COMPONENTS[components - 1] ?? `${components.toString()} floats`;
}

/**
 * Links a reaction firing `on` a particle event: where each of `inherits` (the reacting emitter's
 * compiled inherit entries) comes from in `source`'s slot. An unbuilt source (`undefined`) hands
 * nothing over and reports nothing - its own graph error says why.
 */
export function linkReaction(
  source: ReactionSource | undefined,
  on: FXParticleEventKind,
  inherits: readonly FXInheritEntry[],
): ReactionLink {
  if (source === undefined) {
    return { copies: [], issues: [] };
  }
  const fields = new Map(source.slot.fields.map((field) => [field.name, field]));
  const copies: number[] = [];
  const issues: InheritIssue[] = [];
  for (const entry of inherits) {
    const { source: from, type } = entry.request;
    if (from.kind === "builtin") {
      const lifecycle = fields.get(FX_CORE_LIFECYCLE);
      if (lifecycle !== undefined) {
        copies.push(lifecycle.offset + FX_INHERIT_BUILTIN_COMPONENT[from.field], entry.offset, 1);
      }
      continue;
    }
    const name = inheritSourceLabel(from);
    const field = fields.get(from.name);
    if (field === undefined) {
      issues.push({ kind: "missing", name, expected: type.id });
    } else if (field.components !== type.components) {
      issues.push({
        kind: "mistyped",
        name,
        expected: type.id,
        found: typeOfComponents(field.components),
      });
    } else if (!source.written.death.has(from.name)) {
      issues.push({ kind: "unwritten", name, expected: type.id });
    } else if (!source.written[on].has(from.name)) {
      issues.push({ kind: "late", name, expected: type.id });
    } else {
      copies.push(field.offset, entry.offset, field.components);
    }
  }
  return { copies, issues };
}

/** An attribute a reacting emitter can inherit: one its sources declare, at the type declared. */
export interface InheritCandidate {
  readonly name: string;
  readonly type: AttributeTypeName;
}

/**
 * What `targetId`'s inherited-attribute picker offers: every attribute the emitters it reacts to
 * declare, once per name and type, in scene order. Declared, not compiled: an attribute declared
 * but never written still shows, and is then reported by {@link linkReaction}.
 */
export function inheritCandidates(
  emitters: readonly EmitterDoc[],
  targetId: string,
): readonly InheritCandidate[] {
  const target = emitters.find((emitter) => emitter.id === targetId);
  const sourceIds = new Set(target?.reactions.map((reaction) => reaction.source) ?? []);
  const seen = new Set<string>();
  const candidates: InheritCandidate[] = [];
  for (const emitter of emitters) {
    if (!sourceIds.has(emitter.id)) {
      continue;
    }
    for (const attribute of emitter.behaviorGraph.attributes) {
      const key = `${attribute.name}:${attribute.type}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ name: attribute.name, type: attribute.type });
      }
    }
  }
  return candidates;
}

/**
 * `target`'s reactions' issues (by reaction id, as {@link linkReaction} found them) as warnings on
 * its graph: one per issue and source emitter, attributed to the first `inherited-attribute` node
 * reading that attribute (by id, so stable).
 */
export function inheritIssueWarnings(
  target: EmitterDoc,
  emitters: readonly EmitterDoc[],
  issuesByReaction: ReadonlyMap<string, readonly InheritIssue[]>,
): readonly FXCompilerError[] {
  const readerOf = (name: string): string | undefined =>
    Object.values(target.behaviorGraph.nodes)
      .filter((node) => {
        if (node.type !== "inherited-attribute") {
          return false;
        }
        const source = inheritSourceOf(node.parameters);
        return source.kind === "attribute" && source.name === name;
      })
      .map((node) => node.id)
      .sort()[0];
  const warnings: FXCompilerError[] = [];
  for (const reaction of target.reactions) {
    const sourceName = emitters.find((emitter) => emitter.id === reaction.source)?.name ?? "";
    for (const issue of issuesByReaction.get(reaction.id) ?? []) {
      const nodeId = readerOf(issue.name);
      const params = {
        name: issue.name,
        source: sourceName,
        expected: issue.expected,
        ...(issue.found === undefined ? {} : { found: issue.found }),
      };
      warnings.push({
        code: `inherit-${issue.kind}`,
        message: INHERIT_ISSUE_MESSAGES[issue.kind](params),
        ...(nodeId === undefined ? {} : { nodeId }),
        params,
      });
    }
  }
  return warnings;
}

const INHERIT_ISSUE_MESSAGES: Readonly<
  Record<
    InheritIssue["kind"],
    (params: { name: string; source: string; expected: string; found?: string }) => string
  >
> = {
  missing: ({ name, source }) =>
    `emitter "${source}" has no attribute "${name}" - births reacting to it read the default`,
  mistyped: ({ name, source, expected, found }) =>
    `emitter "${source}" holds "${name}" as ${found ?? "?"}, not ${expected} - births reacting to it read the default`,
  unwritten: ({ name, source }) =>
    `emitter "${source}" never writes "${name}" - births reacting to it read the default`,
  late: ({ name, source }) =>
    `emitter "${source}" writes "${name}" only after a particle's birth - births reacting to its births read the default`,
};
