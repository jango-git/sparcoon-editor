/** localStorage helpers that never throw: a blocked or full store (private mode, quota, disabled
 *  cookies) resolves to `undefined` / `false` instead of breaking the caller. */

export function readString(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Returns `false` when the write is rejected (full/blocked store), never throwing. */
export function writeString(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function readJson(key: string): unknown {
  const raw = readString(key);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Returns `false` when the value can't be serialized or the write is rejected, never throwing. */
export function writeJson(key: string, value: unknown): boolean {
  try {
    return writeString(key, JSON.stringify(value));
  } catch {
    return false;
  }
}
