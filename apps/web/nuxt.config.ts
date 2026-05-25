// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2026-05-25",
  devtools: { enabled: true },
  modules: ["@nuxt/eslint"],
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
});
