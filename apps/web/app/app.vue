<script setup lang="ts">
// iOS Safari does not honour the web manifest fields below, so we wire them
// explicitly through <head>. The theme color matches DESIGN.md accent.
const { t, locale } = useI18n();

useHead({
  // <html lang> follows the active locale so screen readers and the browser
  // font fallback (CJK system fonts in particular) pick the right shaping.
  htmlAttrs: { lang: locale },
  title: () => t("app.title"),
  meta: [
    { name: "viewport", content: "width=device-width, initial-scale=1" },
    { name: "theme-color", content: "#2563eb" },
    // iOS standalone install support.
    { name: "apple-mobile-web-app-capable", content: "yes" },
    { name: "mobile-web-app-capable", content: "yes" },
    { name: "apple-mobile-web-app-title", content: "dbboard" },
    {
      name: "apple-mobile-web-app-status-bar-style",
      content: "black-translucent",
    },
  ],
  link: [
    { rel: "icon", type: "image/x-icon", href: "/icons/favicon.ico" },
    {
      rel: "apple-touch-icon",
      sizes: "180x180",
      href: "/icons/apple-touch-icon-180x180.png",
    },
    { rel: "manifest", href: "/manifest.webmanifest" },
  ],
});

const { canInstall, prompt } = useInstallPrompt();

async function onInstallClick() {
  await prompt();
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <h1>{{ t("app.title") }}</h1>
      <p class="tagline">{{ t("app.tagline") }}</p>
      <div class="header-actions">
        <button v-if="canInstall" type="button" class="install-button" @click="onInstallClick">
          {{ t("install.button") }}
        </button>
        <LocaleSwitcher />
      </div>
    </header>
    <main class="app-main">
      <NuxtPage />
    </main>
  </div>
</template>

<style>
:root {
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    sans-serif;
  color-scheme: light dark;
  --text-muted: #5a6573;
  --accent: #2563eb;
  --border: #e3e6ea;
}

body {
  margin: 0;
  /* Avoid the iOS standalone status bar overlap when display:standalone. */
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
    env(safe-area-inset-left);
}

.app-shell {
  /* Mobile-first: full width, comfortable side padding for thumbs. */
  width: 100%;
  max-width: 60rem;
  margin: 0 auto;
  padding: 1rem;
  box-sizing: border-box;
}

.app-header {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.app-header h1 {
  margin: 0;
  font-size: 1.5rem;
}

.app-header .tagline {
  margin: 0;
  color: var(--text-muted);
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.install-button {
  /* Touch target ≥ 44 × 44 per Phase 1.5 DoD. */
  min-height: 44px;
  min-width: 44px;
  padding: 0 1rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #ffffff;
  font-size: 0.95rem;
  cursor: pointer;
}

.install-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.app-main code {
  background: rgba(127, 127, 127, 0.15);
  padding: 0.1rem 0.35rem;
  border-radius: 0.25rem;
  font-family: ui-monospace, "JetBrains Mono", "SF Mono", monospace;
}

@media (min-width: 768px) {
  .app-header {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .app-header h1 {
    font-size: 1.75rem;
  }

  .app-shell {
    padding: 2rem 1.5rem;
  }
}
</style>
