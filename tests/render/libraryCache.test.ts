import { describe, expect, it } from "vitest";

import { LibraryCache } from "../../src/render/libraryCache";

interface Asset {
  readonly name: string;
  readonly data: string;
}

describe("LibraryCache", () => {
  it("makes new assets, remakes changed ones and disposes the replaced and the gone", () => {
    const disposed: string[] = [];
    const cache = new LibraryCache<Asset, { of: string }>(
      (asset) => ({ of: asset.data }),
      (resource) => disposed.push(resource.of),
      (previous, next) => previous.data !== next.data,
    );
    cache.sync([
      { name: "a", data: "1" },
      { name: "b", data: "2" },
    ]);
    const kept = cache.get("a");
    cache.sync([
      { name: "a", data: "1" },
      { name: "b", data: "3" },
    ]);
    expect(cache.get("a")).toBe(kept);
    expect(cache.get("b")).toEqual({ of: "3" });
    expect(disposed).toEqual(["2"]);
    cache.sync([{ name: "b", data: "3" }]);
    expect(cache.get("a")).toBeUndefined();
    expect(Object.keys(cache.all())).toEqual(["b"]);
    cache.destroy();
    expect(disposed).toEqual(["2", "1", "3"]);
  });
});
