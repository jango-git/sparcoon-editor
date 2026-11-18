import { type FXJSHelperName, jsHelper } from "../ir/FXHelpers.Internal";

/**
 * The preview's `new Function`: a function of `parameters` running `body`, in which each of
 * `helpers` names its `sparcoon/helpers` function - as an exported module imports it. Never in an
 * exported module, which prints the same body as a method instead.
 */
export function buildFunction(
  helpers: readonly FXJSHelperName[],
  parameters: readonly string[],
  body: string,
): unknown {
  const factory = new Function(
    ...helpers,
    `return function (${parameters.join(", ")}) {\n${body}\n};`,
  );
  return factory(...helpers.map(jsHelper)) as unknown;
}
