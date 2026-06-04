import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import swc from "unplugin-swc";

// Cross-implementation conformance battery (ticket 0005). Lives in its
// own config so the default `pnpm test` does **not** spawn Docker /
// the desktop loopback binary. Maintainers opt-in via `pnpm conformance`.
export default defineConfig({
  plugins: [tsconfigPaths(), swc.vite({ module: { type: "es6" } })],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/conformance/**/*.{test,spec}.ts"],
    // Spawning two servers + Postgres tops out around two minutes on a
    // cold CI image; pad to four to avoid masking real hangs while still
    // bounding a wedged child process.
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
