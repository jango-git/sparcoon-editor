import { describe, expect, it, vi } from "vitest";

import { createInitialState } from "../../src/model/editorState";
import { DEFAULT_VIEWPORT_VIEW } from "../../src/model/viewportView";
import type * as envelope from "../../src/persistence/projectEnvelope";
import { deserializeProject, serializeProject } from "../../src/persistence/projectFile";

vi.mock("../../src/persistence/projectEnvelope", async (importOriginal) => ({
  ...(await importOriginal<typeof envelope>()),
  upgradeProject: () => {
    throw new Error("a step failed on a damaged body");
  },
}));

describe("a failing upgrade step", () => {
  it("reads the project file as unreadable instead of throwing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const text = await serializeProject(createInitialState().source, DEFAULT_VIEWPORT_VIEW);
    expect(await deserializeProject(text)).toEqual({ kind: "unreadable" });
  });
});
