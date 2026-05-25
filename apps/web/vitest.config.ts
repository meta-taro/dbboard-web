import { defineVitestConfig } from "@nuxt/test-utils/config";

export default defineVitestConfig({
  test: {
    environment: "happy-dom",
    include: ["app/**/*.{test,spec}.ts", "tests/**/*.{test,spec}.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["app/**/*.{ts,vue}"],
    },
  },
});
