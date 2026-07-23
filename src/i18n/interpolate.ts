/**
 * `{name}`-placeholder substitution, shared by every runtime-key text resolver in this directory
 * (`index.ts`'s own `t()`, `compilerErrors.ts`) - split out of `index.ts` so neither resolver
 * needs to import the other (a resolver that needed `index.ts`'s own dictionary state would be a
 * real circular import; this file has none).
 */

/** Named values a template's `{name}` placeholders substitute to. */
export type Params = Record<string, string | number>;

function formatValue(locale: string, value: string | number): string {
  return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : value;
}

/** Substitutes every `{name}` in `template` from `parameters`, formatting numbers for `locale`.
 *  A placeholder with no matching key is left verbatim. */
export function interpolate(locale: string, template: string, parameters?: Params): string {
  return parameters
    ? template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in parameters ? formatValue(locale, parameters[name] as string | number) : whole,
      )
    : template;
}
