import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import swc from "unplugin-swc";

export default defineConfig({
  // unplugin-swc replaces Vite's default esbuild transform so the
  // `design:paramtypes` metadata Nest's DI needs is actually emitted
  // (vanilla esbuild drops it even with experimentalDecorators).
  plugins: [tsconfigPaths(), swc.vite({ module: { type: "es6" } })],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "**/*.module.ts"],
    },
  },
});
