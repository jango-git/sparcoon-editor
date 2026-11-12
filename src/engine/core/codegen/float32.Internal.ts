/**
 * The shortest decimal (JS number spelling) that reads back as the same 32-bit float as `value` -
 * what a GPU compiler holds a float literal as, so a longer spelling only adds characters to the
 * emitted shader. Never longer than `String(value)`. A JS kernel spells its constants the same way,
 * so the CPU simulation starts from the values the GPU one does.
 */
export function shortestFloat32(value: number): string {
  const full = String(value);
  const target = Math.fround(value);
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = String(Number(value.toPrecision(digits)));
    if (Math.fround(Number(candidate)) === target) {
      return candidate.length < full.length ? candidate : full;
    }
  }
  return full;
}
