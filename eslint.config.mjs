// Root ESLint flat config. App-level configs extend this via import.
// Keeping rules minimal at the root — each app layers in framework rules
// (NestJS via @typescript-eslint, Nuxt via @nuxt/eslint).

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.nuxt/**",
      "**/.output/**",
      "**/.nitro/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },
  {
    // NestJS DI reads constructor parameter types at runtime via the
    // design:paramtypes metadata SWC emits. Converting those imports
    // to `import type` makes TypeScript elide the class reference and
    // breaks the container — the auto-fix is a false positive here.
    // Mirrored from apps/api/eslint.config.mjs so lint-staged (run from
    // the repo root) honours the same exception during pre-commit.
    files: [
      "apps/api/src/app.module.ts",
      "apps/api/src/presentation/**/*.ts",
      "apps/api/src/usecase/**/*.use-case.ts",
      "apps/api/src/infrastructure/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
);
