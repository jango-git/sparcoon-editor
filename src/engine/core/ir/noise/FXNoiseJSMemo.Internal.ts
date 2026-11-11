/**
 * JS source of `name(...args, i)` returning component `i` of a vector result. A scalarized kernel
 * requests each component in a separate call with identical arguments, so the last arguments and
 * results are kept: one evaluation serves every component. `body` fills `r[0..components-1]` and
 * may reassign the arguments (the key is stored first).
 */
export function jsMemoized(
  name: string,
  args: readonly string[],
  components: number,
  body: string,
): string {
  const changed = args.map((arg, index) => `${arg}!==k[${index.toString()}]`).join("||");
  const store = args.map((arg, index) => `k[${index.toString()}]=${arg};`).join("");
  const key = Array.from(args, () => "NaN").join(",");
  const result = Array.from({ length: components }, () => "0").join(",");
  return (
    `var ${name}Key=[${key}],${name}Result=[${result}];\n` +
    `function ${name}(${args.join(",")},i){var k=${name}Key,r=${name}Result;` +
    `if(${changed}){${store}${body}}return r[i];}`
  );
}
