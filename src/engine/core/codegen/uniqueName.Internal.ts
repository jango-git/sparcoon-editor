/**
 * Sanitizes `hint` into a code-safe identifier, appending `<separator><counter>` for uniqueness.
 * `separator` is backend-specific (`_` GLSL, `$` JS) so a generated name can't collide with a
 * backend-reserved one, e.g. an `s_`/`b_` buffer local.
 */
export function uniqueIdentifier(hint: string, separator: string, counter: number): string {
  const cleaned = hint.replace(/[^A-Za-z0-9_]/g, "_");
  const safe = /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return `${safe}${separator}${counter.toString()}`;
}
