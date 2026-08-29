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
      "no-restricted-properties": ["error", ...processOutputRestrictions],
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
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "*.config.ts",
      "*.config.js",
    ],
  },
);
