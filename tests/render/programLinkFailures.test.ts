import type { Material, WebGLRenderer } from "three";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";

import { withLinkFailure } from "../../src/render/applyStatus.Internal";
import { programLinkFailures, sameProgramLinkFailures } from "../../src/render/programLinkFailures";

/** The diagnostics three keeps on a program, for one that linked or one that did not. */
function program(runnable: boolean, fragmentLog = "", vertexLog = ""): unknown {
  return {
    diagnostics: {
      runnable,
      programLog: "",
      vertexShader: { log: vertexLog },
      fragmentShader: { log: fragmentLog },
    },
  };
}

/** A renderer whose `properties` hold the given programs per material, as three keeps them. */
function rendererWith(programs: Map<Material, unknown[]>): WebGLRenderer {
  return {
    properties: {
      get: (material: Material): unknown => {
        const list = programs.get(material);
        return list === undefined
          ? {}
          : { programs: new Map(list.map((entry, index) => [String(index), entry])) };
      },
    },
  } as unknown as WebGLRenderer;
}

function mesh(name = ""): Mesh {
  const result = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  result.name = name;
  return result;
}

const byName = (object: Mesh): "render" | "trail" => (object.name === "trail" ? "trail" : "render");

describe("programLinkFailures", () => {
  it("names the graph of a mesh whose program did not link, with the first line of its log", () => {
    const root = new Group();
    const particles = mesh();
    const trail = mesh("trail");
    root.add(particles, trail);
    const renderer = rendererWith(
      new Map([
        [particles.material as Material, [program(true)]],
        [
          trail.material as Material,
          [program(false, "ERROR: 0:12: 'modelMatrix' : undeclared identifier\nERROR: 1 error")],
        ],
      ]),
    );
    expect(programLinkFailures(renderer, root, byName)).toEqual({
      trail: "ERROR: 0:12: 'modelMatrix' : undeclared identifier",
    });
  });

  it("reads a shadow variant and a vertex log, and nothing of a material not compiled yet", () => {
    const root = new Group();
    const compiled = mesh();
    const depth = new MeshBasicMaterial();
    compiled.customDepthMaterial = depth;
    root.add(compiled, mesh());
    const renderer = rendererWith(new Map([[depth, [program(false, "", "vertex failed")]]]));
    expect(programLinkFailures(renderer, root, byName)).toEqual({ render: "vertex failed" });
  });

  it("leaves out the skipped subtree", () => {
    const root = new Group();
    const gizmo = mesh();
    root.add(gizmo);
    const renderer = rendererWith(new Map([[gizmo.material as Material, [program(false, "x")]]]));
    expect(programLinkFailures(renderer, root, byName, gizmo)).toEqual({});
  });

  it("compares failures by graph and log, whatever order they were found in", () => {
    expect(sameProgramLinkFailures({ render: "a", trail: "b" }, { trail: "b", render: "a" })).toBe(
      true,
    );
    expect(sameProgramLinkFailures({ render: "a" }, {})).toBe(false);
    expect(sameProgramLinkFailures({ render: "a" }, { render: "b" })).toBe(false);
  });
});

describe("withLinkFailure", () => {
  it("fails a running graph and leaves a held one as it is", () => {
    const failed = withLinkFailure({ status: "rebound", messages: [] }, "bad shader");
    expect(failed.status).toBe("invalid");
    expect(failed.messages).toHaveLength(1);
    const held = { status: "invalid", messages: ["held"] } as const;
    expect(withLinkFailure(held, "bad shader")).toBe(held);
    const running = { status: "recompiled", messages: [] } as const;
    expect(withLinkFailure(running, undefined)).toBe(running);
  });
});
