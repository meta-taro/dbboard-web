import rootConfig from "../../eslint.config.mjs";

export default [
  ...rootConfig,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // NestJS DI reads constructor parameter types at runtime via the
    // design:paramtypes metadata SWC emits. Converting those imports
    // to `import type` makes TypeScript elide the class reference and
    // breaks the container — the auto-fix is a false positive here.
    files: [
      "src/app.module.ts",
      "src/presentation/**/*.ts",
      "src/usecase/**/*.use-case.ts",
      "src/infrastructure/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
];
