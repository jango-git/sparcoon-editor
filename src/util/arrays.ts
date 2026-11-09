/** Whether `a` and `b` hold the very same elements in the same order (compared by identity). */
export function sameElements<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((element, index) => element === b[index]);
}
