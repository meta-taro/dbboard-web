<script setup lang="ts">
// Phase 1 scaffold placeholder. The real connection / query UI lands in
// later phases per .claude/roadmap.md (Phase 4 onward).
const apiBase = useRuntimeConfig().public.apiBaseUrl;
const { t } = useI18n();
</script>

<template>
  <section>
    <h2>{{ t("scaffold.heading") }}</h2>
    <p>
      {{ t("scaffold.api-base-label") }}: <code>{{ apiBase }}</code>
    </p>
  </section>
</template>
