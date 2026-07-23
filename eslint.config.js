import eslint from "@eslint/js";
import globals from "globals";
import typescriptEslint from "typescript-eslint";

const CODESTYLE_RULES = {
  "@typescript-eslint/array-type": ["error", { default: "array" }],
  "@typescript-eslint/ban-ts-comment": ["error", { "ts-expect-error": "allow-with-description" }],
  "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
  "@typescript-eslint/consistent-type-imports": "error",
  // allowExpressions: false - arrow functions need it too, so a return-type
  // drift is a compile error at the function itself, not at a distant call site.
  "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: false }],
  // constructors stay unannotated (this codebase's convention: only non-public
  // members get an explicit accessibility keyword).
  "@typescript-eslint/explicit-member-accessibility": [
    "error",
    { accessibility: "explicit", overrides: { constructors: "no-public" } },
  ],
  "@typescript-eslint/explicit-module-boundary-types": "error",
  "@typescript-eslint/member-ordering": "error",
  // Casing only - abbreviation avoidance is enforced via code review (CLAUDE.md), not lint.
  "@typescript-eslint/naming-convention": [
    "error",
    { selector: "default", format: ["camelCase"] },
    { selector: "variable", format: ["camelCase", "UPPER_CASE"] },
    {
      selector: "variable",
      modifiers: ["const"],
      format: ["camelCase", "UPPER_CASE", "PascalCase"],
    },
    { selector: "parameter", format: ["camelCase"], leadingUnderscore: "allow" },
    { selector: "typeLike", format: ["PascalCase"] },
    { selector: "enumMember", format: ["PascalCase", "UPPER_CASE"] },
    {
      selector: "property",
      format: ["camelCase", "PascalCase", "UPPER_CASE"],
      leadingUnderscore: "allow",
    },
    // String-literal keys (e.g. node type strings like "color-over-life") that
    // must be quoted are data, not identifiers - exempt them from casing.
    { selector: "property", modifiers: ["requiresQuotes"], format: null },
  ],
  "@typescript-eslint/no-duplicate-enum-values": "error",
  "@typescript-eslint/no-duplicate-type-constituents": "error",
  "@typescript-eslint/no-empty-object-type": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-extra-non-null-assertion": "error",
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-import-type-side-effects": "error",
  "@typescript-eslint/no-inferrable-types": "warn",
  "@typescript-eslint/no-loop-func": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/no-redundant-type-constituents": "error",
  "@typescript-eslint/no-this-alias": "error",
  "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
  "@typescript-eslint/no-unnecessary-condition": "warn",
  "@typescript-eslint/no-unnecessary-parameter-property-assignment": "error",
  "@typescript-eslint/no-unnecessary-qualifier": "error",
  "@typescript-eslint/no-unnecessary-template-expression": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/no-unnecessary-type-constraint": "error",
  "@typescript-eslint/no-unnecessary-type-conversion": "error",
  "@typescript-eslint/no-unsafe-enum-comparison": "error",
  "@typescript-eslint/no-unsafe-function-type": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "@typescript-eslint/no-wrapper-object-types": "error",
  "@typescript-eslint/prefer-enum-initializers": "error",
  "@typescript-eslint/prefer-find": "error",
  "@typescript-eslint/prefer-for-of": "error",
  "@typescript-eslint/prefer-function-type": "error",
  "@typescript-eslint/prefer-includes": "error",
  "@typescript-eslint/prefer-literal-enum-member": "error",
  "@typescript-eslint/prefer-nullish-coalescing": "error",
  "@typescript-eslint/prefer-optional-chain": "error",
  "@typescript-eslint/prefer-readonly": "error",
  "@typescript-eslint/prefer-reduce-type-parameter": "error",
  "@typescript-eslint/prefer-regexp-exec": "error",
  "@typescript-eslint/prefer-return-this-type": "error",
  "@typescript-eslint/prefer-string-starts-ends-with": "error",
  "@typescript-eslint/require-await": "error",
  "@typescript-eslint/restrict-plus-operands": "error",
  "@typescript-eslint/strict-boolean-expressions": "error",
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "@typescript-eslint/unified-signatures": "error",
  "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
  curly: ["error", "all"],
  eqeqeq: ["error", "always"],
  "no-debugger": "error",
  "no-extend-native": "error",
  "no-implicit-coercion": "error",
  "no-loop-func": "off",
  // No `null` - use `undefined` instead.
  "no-restricted-syntax": [
    "error",
    {
      selector: "Literal[value=null]",
      message: "Use `undefined` instead of `null`.",
    },
    {
      selector: "TSNullKeyword",
      message: "Use `undefined` instead of the `null` type.",
    },
  ],
};

// CODESTYLE_RULES minus the rules that document a public API contract for
// external consumers (return-type drift at a distant call site, class
// member visibility/ordering, chainable-this typing) - not meaningful for
// test files, which nothing else imports.
const TEST_RULES = {
  ...CODESTYLE_RULES,
  "@typescript-eslint/explicit-function-return-type": "off",
  "@typescript-eslint/explicit-member-accessibility": "off",
  "@typescript-eslint/explicit-module-boundary-types": "off",
  "@typescript-eslint/member-ordering": "off",
  "@typescript-eslint/no-non-null-assertion": "off",
  "@typescript-eslint/prefer-readonly": "off",
  "@typescript-eslint/prefer-return-this-type": "off",
};

export default typescriptEslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "*.config.js", "*.config.ts"],
  },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: CODESTYLE_RULES,
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.tests.json",
      },
    },
    rules: TEST_RULES,
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
