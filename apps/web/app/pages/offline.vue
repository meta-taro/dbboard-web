<script setup lang="ts">
// Served by the Workbox service worker as the navigateFallback when the
// network is unreachable. Kept fully self-contained — no runtime data
// fetching — so a cold offline launch can render it from precache alone.
const { t } = useI18n();

useHead({
  title: () => `${t("offline.title")} — ${t("app.title")}`,
});
</script>

<template>
  <section class="offline">
    <h2>{{ t("offline.title") }}</h2>
    <p>{{ t("offline.body") }}</p>
    <p class="hint">{{ t("offline.hint") }}</p>
  </section>
</template>

<style scoped>
.offline {
  max-width: 32rem;
}

.offline h2 {
  margin-top: 0;
}

.offline .hint {
  color: var(--text-muted);
  font-size: 0.9rem;
}
</style>
