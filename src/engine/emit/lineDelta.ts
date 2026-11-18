/**
 * The array literal of `elements` (each an expression: a line written out, a helper's name),
 * taking each long enough run it shares with `base` (the elements of the array `baseExpression`
 * names in the emitted module) as a slice of it and writing out the rest - shorter than the
 * elements in full wherever the two mostly agree. Evaluated once, when the module loads. A run is
 * a slice only past `MIN_SLICE_LENGTH` characters: below it the slice costs more than the elements.
 */
export function lineDeltaLiteral(
  elements: readonly string[],
  base: readonly string[],
  baseExpression: string,
): string {
  const parts: string[] = [];
  let index = 0;
  for (const run of sharedRuns(elements, base)) {
    parts.push(...elements.slice(index, run.at));
    const shared = elements.slice(run.at, run.at + run.length);
    if (shared.join(", ").length > MIN_SLICE_LENGTH) {
      parts.push(
        `...${baseExpression}.slice(${String(run.from)}, ${String(run.from + run.length)})`,
      );
    } else {
      parts.push(...shared);
    }
    index = run.at + run.length;
  }
  parts.push(...elements.slice(index));
  return `[${parts.join(", ")}]`;
}

const MIN_SLICE_LENGTH = 48;

/** A stretch of the elements from `at` equal to `base` from `from`. */
interface FXSharedRun {
  readonly at: number;
  readonly from: number;
  readonly length: number;
}

/** The runs of a longest common subsequence of `lines` and `base`, in order. */
function sharedRuns(lines: readonly string[], base: readonly string[]): FXSharedRun[] {
  const rows = lines.length;
  const columns = base.length;
  // The length of a longest common subsequence of lines[i..] and base[j..], row by row.
  const width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  const common = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      table[i * width + j] =
        lines[i] === base[j]
          ? common(i + 1, j + 1) + 1
          : Math.max(common(i + 1, j), common(i, j + 1));
    }
  }
  const runs: FXSharedRun[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (lines[i] === base[j]) {
      const last = runs.at(-1);
      if (last !== undefined && last.at + last.length === i && last.from + last.length === j) {
        runs[runs.length - 1] = { ...last, length: last.length + 1 };
      } else {
        runs.push({ at: i, from: j, length: 1 });
      }
      i++;
      j++;
    } else if (common(i + 1, j) >= common(i, j + 1)) {
      i++;
    } else {
      j++;
    }
  }
  return runs;
}
