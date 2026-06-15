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
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
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
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
