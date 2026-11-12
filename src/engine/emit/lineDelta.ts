/**
 * The array literal of `lines`, taking each long enough run it shares with `base` as a slice of
 * `baseExpression` (an expression naming `base` in the emitted module) and writing out the rest -
 * shorter than the lines in full wherever the two mostly agree. Evaluated once, when the module
 * loads. A run is a slice only past `MIN_SLICE_LENGTH` characters: below it the slice costs more
 * than the lines.
 */
export function lineDeltaLiteral(
  lines: readonly string[],
  base: readonly string[],
  baseExpression: string,
): string {
  const parts: string[] = [];
  let index = 0;
  for (const run of sharedRuns(lines, base)) {
    pushLines(parts, lines, index, run.at);
    const shared = lines.slice(run.at, run.at + run.length);
    if (JSON.stringify(shared).length > MIN_SLICE_LENGTH) {
      parts.push(
        `...${baseExpression}.slice(${String(run.from)}, ${String(run.from + run.length)})`,
      );
    } else {
      pushLines(parts, lines, run.at, run.at + run.length);
    }
    index = run.at + run.length;
  }
  pushLines(parts, lines, index, lines.length);
  return `[${parts.join(", ")}]`;
}

const MIN_SLICE_LENGTH = 48;

function pushLines(parts: string[], lines: readonly string[], from: number, to: number): void {
  for (let i = from; i < to; i++) {
    parts.push(JSON.stringify(lines[i]));
  }
}

/** A stretch of `lines` from `at` equal to `base` from `from`. */
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
