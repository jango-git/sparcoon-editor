/**
 * The checks a render or trail graph's attribute reads are held to against what the behavior
 * graph actually writes - shared by the live preview and the export, so the two never disagree on
 * what an effect does. (Width and declaration checks are errors elsewhere: `trailChecks.ts`,
 * `undeclaredAttributeErrors`.)
 */

import type { FXCompiledKernel } from "../engine/behavior/FXCompiledKernel";
import { collectReachableNodeIds } from "../engine/core/compiler/FXGraphTraversal.Internal";
import type { FXCompilerError } from "../engine/core/compiler/FXCompilerError";
import type { FXGraph } from "../engine/core/FXGraph";
import type { FXGraphNode } from "../engine/core/FXGraphNode";
import type { EditorAttribute } from "./graphModel";

/**
 * The buffers a compiled behavior writes in either phase - for an attribute, whether anything
 * ever stores into it. Read off the compiled kernel rather than the graph, so it is exactly the
 * writes that run (a `store-attribute` node nothing binds writes nothing).
 */
export function kernelWrittenBuffers(kernel: FXCompiledKernel): ReadonlySet<string> {
  return new Set([...(kernel.spawn?.writtenBuffers ?? []), ...kernel.update.writtenBuffers]);
}

/**
 * A read of a declared attribute the behavior never writes. Attributes have no defaults and a
 * freshly born particle's slot is zeroed, so such a read is always 0 - the runtime even drops the
 * attribute for a zero constant. Valid, so only a warning, but almost always a missing Store
 * Attribute. One per attribute, attributed to its first reading node (by id, so stable); only
 * reachable reads count, as for the attribute requests themselves. An undeclared read is left to
 * `undeclaredAttributeErrors`, which already refuses it.
 */
export function unwrittenAttributeWarnings(
  reader: FXGraph<FXGraphNode>,
  written: ReadonlySet<string>,
  declared: readonly EditorAttribute[],
): readonly FXCompilerError[] {
  const declaredNames = new Set(declared.map((attribute) => attribute.name));
  const firstReader = new Map<string, string>();
  for (const id of [...collectReachableNodeIds(reader)].sort()) {
    const name = reader.getNode(id)?.attributeRequest?.name;
    if (
      name !== undefined &&
      declaredNames.has(name) &&
      !written.has(name) &&
      !firstReader.has(name)
    ) {
      firstReader.set(name, id);
    }
  }
  return [...firstReader].map(([name, nodeId]) => ({
    code: "attribute-never-written",
    message: `attribute "${name}" is read here but the behavior never writes it - it is always 0`,
    nodeId,
    params: { name },
  }));
}
