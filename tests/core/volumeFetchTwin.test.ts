import { FX_VOLUME_HEADER_FLOATS, fxVolumeFetch } from "sparcoon";
import { describe, expect, it } from "vitest";

import { FX_VOLUME_FETCH_HELPER } from "../../src/engine/core/ir/FXFunctions.Internal";

describe("the volumeFetch helper", () => {
  it("reads a volume as sparcoon's fxVolumeFetch, which an exported kernel imports", () => {
    const helper = new Function(`${FX_VOLUME_FETCH_HELPER}\nreturn fxVolumeFetch;`)() as (
      ...args: unknown[]
    ) => number;
    const size = [5, 3, 4];
    const table = new Float32Array(FX_VOLUME_HEADER_FLOATS + 5 * 3 * 4);
    table.set(size);
    for (let i = FX_VOLUME_HEADER_FLOATS; i < table.length; i++) {
      table[i] = ((i * 37) % 255) / 255;
    }
    for (let i = 0; i < 200; i++) {
      const [u, v, w] = [i * 0.0137 - 0.3, i * 0.0071 - 0.2, 1.2 - i * 0.0083];
      expect(helper(table, u, v, w)).toBe(fxVolumeFetch(table, u, v, w));
    }
  });
});
