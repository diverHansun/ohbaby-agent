import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

const processOutputRestrictions = [
  {
    message: "Backend production code must not write directly to stdout.",
    object: "process",
    property: "stdout",
  },
  {
    message: "Backend production code must not write directly to stderr.",
    object: "process",
    property: "stderr",
  },
  {
    message:
      "Backend production code must return or inject warnings instead of emitting them globally.",
    object: "process",
    property: "emitWarning",
  },
];

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "no-console": "warn",
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: [
      "packages/ohbaby-agent/src/**/*.{ts,tsx}",
      "packages/ohbaby-server/src/**/*.{ts,tsx}",
    ],
    ignores: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.unit.ts",
      "**/*.contract.ts",
      "**/*.integration.ts",
      "**/*.e2e.ts",
    ],
    rules: {
      "no-console": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              message:
                "Backend production code must use the global process object so output ownership checks cannot be aliased.",
              name: "node:process",
            },
            {
              message:
                "Backend production code must use the global process object so output ownership checks cannot be aliased.",
              name: "process",
            },
          ],
        },
      ],
      "no-restricted-properties": ["error", ...processOutputRestrictions],
      "no-restricted-syntax": [
        "error",
        {
          message:
            "Backend production code must not destructure process output channels.",
          selector:
            "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name=/^(emitWarning|stderr|stdout)$/]",
        },
        {
          message:
            "Backend production code must not destructure globalThis.process output channels.",
          selector:
            "VariableDeclarator[init.type='MemberExpression'][init.object.name='globalThis'][init.property.name='process'] > ObjectPattern > Property[key.name=/^(emitWarning|stderr|stdout)$/]",
        },
        {
          message:
            "Backend production code must not destructure globalThis process output channels.",
          selector:
            "VariableDeclarator[init.type='MemberExpression'][init.computed=true][init.object.name='globalThis'][init.property.value='process'] > ObjectPattern > Property[key.name=/^(emitWarning|stderr|stdout)$/]",
        },
        {
          message:
            "Backend production code must not alias the global process object.",
          selector:
            "VariableDeclarator[id.type='Identifier'][init.name='process']",
        },
        {
          message: "Backend production code must not alias globalThis.process.",
          selector:
            "VariableDeclarator[id.type='Identifier'][init.object.name='globalThis'][init.property.name='process']",
        },
        {
          message: "Backend production code must not alias globalThis process.",
          selector:
            "VariableDeclarator[id.type='Identifier'][init.computed=true][init.object.name='globalThis'][init.property.value='process']",
        },
        {
          message:
            "Backend production code must not access output channels through globalThis.process.",
          selector:
            "MemberExpression[object.object.name='globalThis'][object.property.name='process'][property.name=/^(emitWarning|stderr|stdout)$/]",
        },
        {
          message:
            "Backend production code must not access output channels through globalThis process.",
          selector:
            "MemberExpression[object.type='MemberExpression'][object.computed=true][object.object.name='globalThis'][object.property.value='process'][property.name=/^(emitWarning|stderr|stdout)$/]",
        },
      ],
    },
  },
  {
    files: ["packages/ohbaby-agent/src/services/database/connection.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...processOutputRestrictions.filter(
          (restriction) => restriction.property !== "emitWarning",
        ),
      ],
    },
  },
  {
    files: ["packages/ohbaby-cli/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              message:
                "CLI production code must not statically load heavyweight agent/server runtimes; use type-only imports or the composition-root loader.",
              name: "ohbaby-agent",
              allowTypeImports: true,
            },
            {
              message:
                "CLI production code must not statically load heavyweight agent/server runtimes; use type-only imports or the composition-root loader.",
              name: "ohbaby-server",
              allowTypeImports: true,
            },
            {
              message:
                "CLI production code must not create CommonJS loaders that bypass the runtime import boundary.",
              name: "node:module",
            },
            {
              message:
                "CLI production code must not create CommonJS loaders that bypass the runtime import boundary.",
              name: "module",
            },
          ],
          patterns: [
            {
              group: [
                "ohbaby-agent/*",
                "ohbaby-server/*",
                "**/ohbaby-agent/src/**",
                "**/ohbaby-agent/dist/**",
                "**/ohbaby-server/src/**",
                "**/ohbaby-server/dist/**",
              ],
              message:
                "CLI production code must not import agent/server runtime internals.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          message:
            "CLI production code must not dynamically load agent/server runtimes outside the composition-root loader.",
          selector: "ImportExpression:not([source.type='Literal'])",
        },
        {
          message:
            "CLI production code must not dynamically load agent/server runtimes outside the composition-root loader.",
          selector:
            "ImportExpression[source.type='Literal'][source.value=/(?:ohbaby-(?:agent|server)|^(?:node:)?module$)/]",
        },
      ],
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "*.config.ts",
      "*.config.js",
    ],
  },
);
