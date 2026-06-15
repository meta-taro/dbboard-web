import { defineConfig, devices } from "@playwright/test";

// Phase 4 slice 4 (issue 0014) — mobile + desktop E2E baseline.
//
// The suite is deliberately hermetic: every API call is intercepted via
// `page.route()` in the spec fixtures, so this config only needs to boot
// the Nuxt dev server. The NestJS API never runs under Playwright — its
// own contract conformance battery lives in apps/api/tests/conformance/.
//
// Excluded from `pnpm -r test` by Vitest's narrower include glob; opt in
// with `pnpm e2e` (root) or `pnpm --filter @dbboard-web/web e2e`.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    // Pin to IPv4 so Chromium's resolver does not race the Node listener:
    // on Windows, `nuxt dev` defaults to binding `[::1]` only, and Chromium
    // prefers IPv4 for `localhost`, which leads to a connect-then-hang.
    baseURL: "http://127.0.0.1:3000",
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // `--host 127.0.0.1` forces Nuxt to bind IPv4 in line with the baseURL
    // pin above. We invoke `nuxt dev` via `pnpm exec` so pnpm doesn't pass
    // the script-args delimiter `--` to Nuxt's CLI (Nuxt would otherwise
    // read it as a positional `rootDir`, fall back to the default scaffold
    // and serve the welcome page instead of our app).
    command: "pnpm exec nuxt dev --host 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    // Disables Vite's HMR error overlay + DevTools panel under nuxt.config.ts.
    env: { DBBOARD_E2E: "1" },
  },
});
