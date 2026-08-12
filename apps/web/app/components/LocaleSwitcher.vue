<script setup lang="ts">
// User-facing locale switcher. Auto-discovered by Nuxt's component scanner
// and placed in the header by app/app.vue.
//
// On change, setLocale() updates the dbboard_lang cookie (via the @nuxtjs/i18n
// detectBrowserLanguage config), so the choice survives a reload. The ?lang=
// query in app/middleware/locale-query.global.ts still takes priority when
// present — exactly mirroring desktop's DBBOARD_LANG > OS > en ordering.

import { computed } from "vue";
import { SUPPORTED_LOCALES, isSupportedLocale } from "../../i18n/config";

const { locale, setLocale, t } = useI18n();

const options = computed(() => SUPPORTED_LOCALES);

// `v-model`, not `:value` + `@change`. A `value` binding on a `<select>` is a
// DOM property, and the server has no DOM: it renders `value="ja"` as an
// attribute, which HTML ignores on `<select>`, and hydration leaves it alone
// because the attribute already matches. The widget then shows whichever
// option happens to be first while the app runs in another language.
// `v-model` renders `selected` on the option instead, which is the way the
// markup is allowed to say this.
const selected = computed<string>({
  get: () => locale.value,
  set: (next: string) => {
    if (!isSupportedLocale(next)) {
      return;
    }
    // Fire-and-forget: nothing here waits on the switch, and `locale` is what
    // this control reads back once it lands.
    void setLocale(next);
  },
});
</script>

<template>
  <label class="locale-switcher">
    <span class="locale-switcher__label">{{ t("locale-switcher.label") }}</span>
    <select v-model="selected" class="locale-switcher__select">
      <option v-for="opt in options" :key="opt.code" :value="opt.code">
        {{ opt.name }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.locale-switcher {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
}

.locale-switcher__label {
  color: var(--text-muted);
}

.locale-switcher__select {
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

.locale-switcher__select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
