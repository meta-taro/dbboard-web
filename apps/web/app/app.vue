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
        <ThemeSwitcher />
        <LocaleSwitcher />
      </div>
    </header>
    <main class="app-main">
      <NuxtPage />
    </main>
  </div>
</template>

<style>
/*
 * The palette. Mirrors desktop ADR-0041 (Light / Dark / Auto) and the token
 * table in DESIGN.md.
 *
 * Three states, in this order:
 *
 *   :root                                    light, and the default
 *   :root:not([data-theme="light"]) @media   auto — the OS decides
 *   :root[data-theme="dark"]                 dark, chosen explicitly
 *
 * `auto` writes no attribute at all (see app/utils/theme.ts), so the media
 * query is the only thing deciding and there is no second code path that
 * could disagree with it. The explicit block comes last so it outranks the
 * media query at equal specificity — that is what lets someone on a dark OS
 * choose light.
 *
 * `color-scheme` is set per state rather than once as `light dark`. Declaring
 * both while the custom properties were light-only is exactly what was broken
 * here before: the UA painted a dark canvas and every panel stayed white.
 */
:root {
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    sans-serif;
  color-scheme: light;
  --bg: #ffffff;
  --surface: #f5f6f8;
  --surface-raised: #ffffff;
  --border: #e3e6ea;
  --border-faint: #eef1f4;
  --text: #0f1115;
  --text-muted: #5a6573;
  --accent: #2563eb;
  /* Foreground on an --accent fill. Not white by coincidence: it has to
     satisfy contrast against both accent values, and both are mid-blues. */
  --accent-contrast: #ffffff;
  --success: #16a34a;
  --warning: #d97706;
  --danger: #dc2626;
  /* Text-on-background variants. The fill colours above are tuned for solid
     blocks and only just clear AA as body text; these clear it comfortably. */
  --success-text: #166534;
  --danger-text: #991b1b;
  --code-bg: rgba(15, 17, 21, 0.06);
  /* Tints: a translucent wash of the matching fill, used behind banners and
     status chips so the message reads as a block without a second border
     colour. Alpha differs per theme — the same alpha over a dark canvas
     disappears. */
  --surface-sunken: rgba(15, 17, 21, 0.02);
  --danger-tint: rgba(220, 38, 38, 0.1);
  --danger-tint-border: rgba(220, 38, 38, 0.3);
  --success-tint: rgba(34, 197, 94, 0.15);
  --muted-tint: rgba(120, 113, 108, 0.1);
  --muted-tint-border: rgba(120, 113, 108, 0.3);
  /* Scrim behind a modal. Black in both themes rather than a wash of the
     canvas colour: what it has to do is push the page back, and over a dark
     canvas a dark-grey wash is invisible. The light theme needs more of it,
     because there is more to push back. */
  --scrim: rgba(0, 0, 0, 0.45);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0b0d10;
    --surface: #14181d;
    --surface-raised: #14181d;
    --border: #1f242a;
    --border-faint: #171c21;
    --text: #e6e9ee;
    --text-muted: #8a96a3;
    --accent: #3b82f6;
    --accent-contrast: #ffffff;
    --success: #22c55e;
    --warning: #f59e0b;
    --danger: #ef4444;
    --success-text: #86efac;
    --danger-text: #fca5a5;
    --code-bg: rgba(230, 233, 238, 0.1);
    --surface-sunken: rgba(230, 233, 238, 0.03);
    --danger-tint: rgba(239, 68, 68, 0.16);
    --danger-tint-border: rgba(239, 68, 68, 0.38);
    --success-tint: rgba(34, 197, 94, 0.2);
    --muted-tint: rgba(138, 150, 163, 0.12);
    --muted-tint-border: rgba(138, 150, 163, 0.32);
    --scrim: rgba(0, 0, 0, 0.6);
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0b0d10;
  --surface: #14181d;
  --surface-raised: #14181d;
  --border: #1f242a;
  --border-faint: #171c21;
  --text: #e6e9ee;
  --text-muted: #8a96a3;
  --accent: #3b82f6;
  --accent-contrast: #ffffff;
  --success: #22c55e;
  --warning: #f59e0b;
  --danger: #ef4444;
  --success-text: #86efac;
  --danger-text: #fca5a5;
  --code-bg: rgba(230, 233, 238, 0.1);
  --surface-sunken: rgba(230, 233, 238, 0.03);
  --danger-tint: rgba(239, 68, 68, 0.16);
  --danger-tint-border: rgba(239, 68, 68, 0.38);
  --success-tint: rgba(34, 197, 94, 0.2);
  --muted-tint: rgba(138, 150, 163, 0.12);
  --muted-tint-border: rgba(138, 150, 163, 0.32);
  --scrim: rgba(0, 0, 0, 0.6);
}

body {
  background: var(--bg);
  color: var(--text);
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
  color: var(--accent-contrast);
  font-size: 0.95rem;
  cursor: pointer;
}

.install-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.app-main code {
  background: var(--code-bg);
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
