/**
 * Programs three could not link. A graph can pass every check of the editor and still produce a
 * shader the GPU driver rejects; three then draws nothing with that material and only logs the
 * error. The views read the outcome back here, after a frame has compiled their materials, so the
 * failure shows as an error of the graph that produced the material.
 */

import type { Material, Object3D, WebGLRenderer } from "three";
import { Mesh } from "three";

import type { GraphName } from "../model/graphSlots";

/** The diagnostics three keeps on a program it linked with `debug.checkShaderErrors` on. */
interface ProgramDiagnostics {
  readonly runnable: boolean;
  readonly programLog: string;
  readonly vertexShader: { readonly log: string };
  readonly fragmentShader: { readonly log: string };
}

/** What three keeps per material in `renderer.properties`: one program per variant. */
interface MaterialProgramProperties {
  readonly programs?: ReadonlyMap<string, { readonly diagnostics?: ProgramDiagnostics }>;
}

/** The first line of the first log of a program that did not link, if one did not. */
function unlinkedProgramLog(renderer: WebGLRenderer, material: Material): string | undefined {
  const { programs } = renderer.properties.get(material) as MaterialProgramProperties;
  for (const program of programs?.values() ?? []) {
    const diagnostics = program.diagnostics;
    if (diagnostics === undefined || diagnostics.runnable) {
      continue;
    }
    const log = [
      diagnostics.fragmentShader.log,
      diagnostics.vertexShader.log,
      diagnostics.programLog,
    ].find((text) => text.trim() !== "");
    return log?.trim().split("\n")[0]?.trim() ?? "";
  }
  return undefined;
}

/** Every material a mesh draws with, its shadow variants included. */
function materialsOf(mesh: Mesh): Material[] {
  const materials = Array.isArray(mesh.material) ? [...mesh.material] : [mesh.material];
  if (mesh.customDepthMaterial !== undefined) {
    materials.push(mesh.customDepthMaterial);
  }
  if (mesh.customDistanceMaterial !== undefined) {
    materials.push(mesh.customDistanceMaterial);
  }
  return materials;
}

/** Link failures by graph: the first line of the driver's log for each graph that has one. */
export type ProgramLinkFailures = Partial<Record<GraphName, string>>;

/**
 * The link failures of the meshes under `root`. `graphOf` names the graph a mesh draws for;
 * `skip` is a subtree that is not the preview's own, such as the editor's gizmo.
 */
export function programLinkFailures(
  renderer: WebGLRenderer,
  root: Object3D,
  graphOf: (mesh: Mesh) => GraphName,
  skip?: Object3D,
): ProgramLinkFailures {
  const failures: ProgramLinkFailures = {};
  const visit = (object: Object3D): void => {
    if (object === skip) {
      return;
    }
    if (object instanceof Mesh) {
      const graph = graphOf(object);
      if (failures[graph] === undefined) {
        for (const material of materialsOf(object)) {
          const log = unlinkedProgramLog(renderer, material);
          if (log !== undefined) {
            failures[graph] = log;
            break;
          }
        }
      }
    }
    for (const child of object.children) {
      visit(child);
    }
  };
  visit(root);
  return failures;
}

/** Whether two sets of failures name the same graphs with the same logs. */
export function sameProgramLinkFailures(a: ProgramLinkFailures, b: ProgramLinkFailures): boolean {
  const graphs = Object.keys(a) as GraphName[];
  return graphs.length === Object.keys(b).length && graphs.every((graph) => a[graph] === b[graph]);
}
