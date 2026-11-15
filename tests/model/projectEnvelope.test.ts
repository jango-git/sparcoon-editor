import { describe, expect, it } from "vitest";

import {
  type ProjectUpgrade,
  unwrapProject,
  upgradeProject,
} from "../../src/persistence/projectEnvelope";

/** Two steps that each append their format to the body's trail: 1 -> 2, then 2 -> 3. */
const UPGRADES: readonly ProjectUpgrade[] = [
  (body) => [...(body as number[]), 1],
  (body) => [...(body as number[]), 2],
];

function upgraded(version: number): unknown {
  return upgradeProject(unwrapProject({ version, source: [] }), UPGRADES);
}

describe("upgradeProject", () => {
  it("runs a project through every step from its format up, in order", () => {
    expect(upgraded(1)).toEqual([1, 2]);
    expect(upgraded(2)).toEqual([2]);
  });

  it("leaves a project in the current or a later format as it is", () => {
    expect(upgraded(3)).toEqual([]);
    expect(upgraded(7)).toEqual([]);
  });

  it("runs a bare source with no envelope through every step, as format 1", () => {
    expect(upgradeProject(unwrapProject([]), UPGRADES)).toEqual([1, 2]);
  });
});
