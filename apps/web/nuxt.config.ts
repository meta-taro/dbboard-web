// https://nuxt.com/docs/api/configuration/nuxt-config
import { pwaManifest } from "./app/pwa/manifest";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./i18n/config";

// Under Playwright we don't want Vite's HMR error overlay to intercept
// pointer events when an unrelated HMR-internal hiccup fires (Vite 7 has
// a known `_clientModule` undefined throw during FSWatcher diffs, which
// is harmless to the running app but blocks `locator.click()` in tests).
// Playwright sets PLAYWRIGHT_TEST=1 in its child env automatically; we
// also honour the explicit DBBOARD_E2E flag for ad-hoc runs.
const isE2E = process.env.PLAYWRIGHT_TEST === "1" || process.env.DBBOARD_E2E === "1";

export default defineNuxtConfig({
  compatibilityDate: "2026-05-25",
  devtools: { enabled: !isE2E },
  modules: ["@nuxt/eslint", "@nuxtjs/i18n", "@vite-pwa/nuxt"],
  vite: {
    server: {
      hmr: isE2E ? { overlay: false } : undefined,
      watch: {
        // Keep Playwright artefacts from re-triggering HMR. Do NOT include
        // `.nuxt/` here — Nuxt regenerates route stubs there in dev and
        // Vite must keep watching it for the SPA to wire up correctly.
        ignored: ["**/test-results/**", "**/playwright-report/**"],
      },
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
  runtimeConfig: {
    public: {
      // Base URL of the NestJS API. Override at runtime via NUXT_PUBLIC_API_BASE_URL.
      apiBaseUrl: "http://localhost:4000",
    },
  },
  i18n: {
    // Stage 1 locales mirror desktop ADR-0015. Shared with tests via ./i18n/config.
    locales: SUPPORTED_LOCALES,
    defaultLocale: DEFAULT_LOCALE,
    strategy: "no_prefix",
    lazy: true,
    // Cookie + Accept-Language. The ?lang= query is handled by
    // app/middleware/locale-query.global.ts and takes priority over both.
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: "dbboard_lang",
      cookieSecure: true,
      redirectOn: "root",
      fallbackLocale: DEFAULT_LOCALE,
    },
  },
  pwa: {
    registerType: "autoUpdate",
    // Pre-generated icon assets live under public/icons/ (see pwa-assets.config.ts).
    // The manifest object is shared with the unit tests via ./app/pwa/manifest.
    manifest: pwaManifest,
    workbox: {
      // Cache the app shell so a cold offline launch can serve /offline.
      globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
      navigateFallback: "/offline",
      navigateFallbackDenylist: [/^\/api\//],
    },
    // Disable in dev to avoid stale service workers during HMR. Enable
    // manually with NUXT_PWA_DEV=1 when debugging the service worker.
    devOptions: {
      enabled: false,
      type: "module",
    },
    client: {
      // Install prompt is owned by useInstallPrompt() and exposed opt-in;
      // the module's built-in install banner must stay off.
      installPrompt: false,
    },
  },
});
