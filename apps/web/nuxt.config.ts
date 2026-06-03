// https://nuxt.com/docs/api/configuration/nuxt-config
import { pwaManifest } from "./app/pwa/manifest";

export default defineNuxtConfig({
  compatibilityDate: "2026-05-25",
  devtools: { enabled: true },
  modules: ["@nuxt/eslint", "@vite-pwa/nuxt"],
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
