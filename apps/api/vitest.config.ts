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
    // Integration specs that boot a full Nest AppModule occasionally
    // exceed the vitest default 5s when several spec files compile +
    // cold-start in parallel (pnpm -r test races the apps/api and
    // apps/web workspaces; the pre-push hook stacks more load on top).
    // 15s leaves enough headroom for cold-start contention without
    // hiding genuinely slow tests.
    testTimeout: 15_000,
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "**/*.module.ts"],
    },
  },
});
