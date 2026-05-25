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
);
