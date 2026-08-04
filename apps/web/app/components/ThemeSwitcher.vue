<script setup lang="ts">
// Light / Dark / Auto, mirroring desktop ADR-0041's settings control.
// Auto-discovered by Nuxt's component scanner and placed in the header by
// app/app.vue, next to LocaleSwitcher — both are shell-level preferences.
//
// A <select> rather than a three-way toggle: the labels are words, so the
// current state is readable without relying on colour or an icon
// (DESIGN.md accessibility). It also matches LocaleSwitcher's shape.

import { useI18n } from "vue-i18n";
import { useTheme } from "../composables/useTheme";
import { THEME_PREFERENCES, type ThemePreference } from "../utils/theme";

const { t } = useI18n();
const { preference, setPreference } = useTheme();

function isThemePreference(value: string): value is ThemePreference {
  return (THEME_PREFERENCES as readonly string[]).includes(value);
}

function onChange(event: Event) {
  const next = (event.target as HTMLSelectElement).value;
  // Same guard as LocaleSwitcher: never widen the union from DOM input.
  if (!isThemePreference(next)) return;
  setPreference(next);
}
</script>

<template>
  <label class="theme-switcher">
    <span class="theme-switcher__label">{{ t("theme-switcher.label") }}</span>
    <select
      :value="preference"
      class="theme-switcher__select"
      data-testid="theme-switcher"
      @change="onChange"
    >
      <option v-for="option in THEME_PREFERENCES" :key="option" :value="option">
        {{ t(`theme-switcher.option.${option}`) }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.theme-switcher {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
}

.theme-switcher__label {
  color: var(--text-muted);
}

.theme-switcher__select {
  /* Touch target ≥ 44 × 44 per Phase 1.5 DoD. */
  min-height: 44px;
  padding: 0 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
  font-size: 0.95rem;
  cursor: pointer;
}

.theme-switcher__select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
